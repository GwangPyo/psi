import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { getPiInvocation } from "../pi-invocation.ts";

const STATUS_KEY = "project-graph";
const STATUS_WIDGET = "project-graph-indexing";
const DEFAULT_POLL_INTERVAL_MS = 3000;

type JsonRecord = Record<string, unknown>;

interface McpServerConfig {
	command: string;
	args: string[];
	env: Record<string, string>;
	requestTimeoutMs: number;
}

export interface ProjectGraphClient {
	call(toolName: string, arguments_: JsonRecord): Promise<JsonRecord>;
}

export interface ProjectGraphExtensionOptions {
	createClient?: (cwd: string) => ProjectGraphClient;
	pollIntervalMs?: number;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function resolveProjectGraphServer(cwd: string): Promise<McpServerConfig> {
	const configuredRoot = process.env.PI_PROJECT_GRAPHRAG_ROOT;
	const extensionRoot = dirname(fileURLToPath(import.meta.url));
	const piInvocation = getPiInvocation([]);
	const candidates = [
		...(configuredRoot ? [configuredRoot] : []),
		join(extensionRoot, "backend"),
		join(dirname(process.execPath), "project-graph-backend"),
	];
	for (const backendRoot of candidates) {
		try {
			await access(join(backendRoot, "project_graphrag", "mcp_server.py"));
			return {
				command: process.env.PI_PROJECT_GRAPH_PYTHON ?? "python3",
				args: ["-m", "project_graphrag.mcp_server"],
				env: {
					PYTHONPATH: backendRoot,
					PROJECT_GRAPHRAG_PROJECT_ROOT: cwd,
					PROJECT_GRAPHRAG_DATA_ROOT:
						process.env.PROJECT_GRAPHRAG_DATA_ROOT ?? join(getAgentDir(), "project-graph"),
					PROJECT_GRAPHRAG_PI_COMMAND:
						process.env.PROJECT_GRAPHRAG_PI_COMMAND ??
						JSON.stringify([piInvocation.command, ...piInvocation.args]),
				},
				requestTimeoutMs: 120_000,
			};
		} catch {
			// Try the next packaged location.
		}
	}

	throw new Error("The bundled Project GraphRAG backend is missing from this Pi installation.");
}

class StdioProjectGraphClient implements ProjectGraphClient {
	readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async call(toolName: string, arguments_: JsonRecord): Promise<JsonRecord> {
		const config = await resolveProjectGraphServer(this.cwd);
		return await new Promise<JsonRecord>((resolveCall, rejectCall) => {
			const child = spawn(config.command, config.args, {
				cwd: this.cwd,
				env: { ...process.env, ...config.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let settled = false;
			const finish = (error: Error | undefined, value?: JsonRecord): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				child.kill("SIGTERM");
				if (error) rejectCall(error);
				else if (value) resolveCall(value);
				else rejectCall(new Error("project_graph returned no result"));
			};
			const timeout = setTimeout(() => {
				finish(new Error(`project_graph timed out after ${config.requestTimeoutMs}ms`));
			}, config.requestTimeoutMs);
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				while (stdout.includes("\n")) {
					const newline = stdout.indexOf("\n");
					const line = stdout.slice(0, newline).trim();
					stdout = stdout.slice(newline + 1);
					if (!line) continue;
					let response: unknown;
					try {
						response = JSON.parse(line);
					} catch {
						continue;
					}
					if (!isRecord(response) || response.id !== 2) continue;
					if (isRecord(response.error)) {
						finish(new Error(stringValue(response.error.message) ?? "project_graph MCP request failed"));
						return;
					}
					const result = response.result;
					if (!isRecord(result)) {
						finish(new Error("project_graph MCP returned an invalid result"));
						return;
					}
					if (result.isError === true) {
						finish(new Error(extractText(result) ?? "project_graph tool failed"));
						return;
					}
					const structured = result.structuredContent;
					if (!isRecord(structured)) {
						finish(new Error("project_graph tool returned no structured content"));
						return;
					}
					finish(undefined, structured);
				}
			});
			child.on("error", (error) => finish(error));
			child.on("close", (code) => {
				if (settled) return;
				finish(
					new Error(`project_graph exited with code ${code ?? "unknown"}${stderr ? `: ${stderr.trim()}` : ""}`),
				);
			});
			child.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "pi-project-graph-ui", version: "1.0.0" },
					},
				})}\n`,
			);
			child.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: toolName, arguments: arguments_ },
				})}\n`,
			);
		});
	}
}

function extractText(result: JsonRecord): string | undefined {
	if (!Array.isArray(result.content)) return undefined;
	for (const item of result.content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") return item.text;
	}
	return undefined;
}

function jobFrom(payload: JsonRecord): JsonRecord {
	return isRecord(payload.job) ? payload.job : payload;
}

function indexFrom(payload: JsonRecord): JsonRecord | undefined {
	return isRecord(payload.index) ? payload.index : undefined;
}

function graphIndexReady(payload: JsonRecord): boolean {
	return stringValue(indexFrom(payload)?.state) === "ready";
}

function progressFrom(job: JsonRecord): JsonRecord | undefined {
	return isRecord(job.progress) ? job.progress : undefined;
}

function formatPhase(phase: string): string {
	return phase.replaceAll("_", " ");
}

function completedRatio(
	progress: JsonRecord,
	completedKey: string,
	totalKey: string,
	unit: string,
): string | undefined {
	const completed = numberValue(progress[completedKey]);
	const total = numberValue(progress[totalKey]);
	if (completed === undefined || total === undefined) return undefined;
	return `${completed}/${total} ${unit}`;
}

function compactProgress(progress: JsonRecord | undefined): string | undefined {
	if (!progress) return undefined;
	return (
		completedRatio(progress, "items_completed", "items_total", "items") ??
		completedRatio(progress, "workflows_completed", "workflows_total", "workflows")
	);
}

export function formatProjectGraphStatus(payload: JsonRecord): string {
	const job = jobFrom(payload);
	const index = indexFrom(payload);
	const progress = progressFrom(job);
	const state = stringValue(job.state) ?? "unknown";
	const phase = stringValue(progress?.phase);
	const message = stringValue(progress?.message);
	const workflow = stringValue(progress?.workflow);
	const operation = stringValue(progress?.operation);
	const workflowRatio = progress
		? completedRatio(progress, "workflows_completed", "workflows_total", "complete")
		: undefined;
	const itemRatio = progress ? completedRatio(progress, "items_completed", "items_total", "complete") : undefined;
	const lines = [
		`Job: ${state}`,
		...(phase ? [`Phase: ${formatPhase(phase)}`] : []),
		...(workflow ? [`Workflow: ${workflow}${workflowRatio ? ` (${workflowRatio})` : ""}`] : []),
		...(operation ? [`Operation: ${operation}${itemRatio ? ` (${itemRatio})` : ""}`] : []),
		...(numberValue(progress?.documents_total) === undefined
			? []
			: [`Documents: ${numberValue(progress?.documents_total)}`]),
		...(numberValue(progress?.objects_indexed) === undefined
			? []
			: [`Static objects: ${numberValue(progress?.objects_indexed)}`]),
		...(message ? [`Detail: ${message}`] : []),
		...(stringValue(job.job_id) ? [`Job ID: ${stringValue(job.job_id)}`] : []),
		...(index ? [`Index: ${stringValue(index.state) ?? "unknown"}`] : []),
		...(stringValue(job.error) ? [`Error: ${stringValue(job.error)}`] : []),
	];
	return lines.join("\n");
}

function toolPayload(result: unknown): JsonRecord | undefined {
	if (!isRecord(result)) return undefined;
	if (isRecord(result.structuredContent)) return result.structuredContent;
	if (isRecord(result.details)) return result.details;
	const text = extractText(result);
	if (!text) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function graphToolName(name: string, suffix: string): boolean {
	return name === suffix || name.endsWith(`_${suffix}`);
}

export function createProjectGraphExtension(options: ProjectGraphExtensionOptions = {}) {
	return function projectGraphExtension(pi: ExtensionAPI): void {
		const createClient = options.createClient ?? ((cwd: string) => new StdioProjectGraphClient(cwd));
		const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		let pollTimer: NodeJS.Timeout | undefined;
		let pollGeneration = 0;
		let completionAnnouncedFor: string | undefined;
		let managedGraphTools: string[] | undefined;

		function setGraphToolAvailability(backendAvailable: boolean, searchAvailable: boolean): void {
			const activeTools = pi.getActiveTools();
			const currentGraphTools = activeTools.filter((name) => name === "graph_search" || name === "graph_status");
			if (
				managedGraphTools &&
				(currentGraphTools.length !== managedGraphTools.length ||
					currentGraphTools.some((name, index) => name !== managedGraphTools?.[index]))
			) {
				return;
			}
			if (!managedGraphTools && currentGraphTools.length === 0) return;
			const nextTools = activeTools.filter((name) => name !== "graph_search" && name !== "graph_status");
			const nextGraphTools: string[] = [];
			if (backendAvailable && searchAvailable) nextGraphTools.push("graph_search");
			if (backendAvailable) nextGraphTools.push("graph_status");
			nextTools.push(...nextGraphTools);
			if (nextTools.length !== activeTools.length || nextTools.some((name, index) => name !== activeTools[index])) {
				pi.setActiveTools(nextTools);
			}
			managedGraphTools = nextGraphTools;
		}

		pi.registerTool({
			name: "graph_search",
			label: "Search project graph",
			description:
				"Search the active project's semantic graph for existing implementations, symbols, architecture, and dependencies. Use this proactively during planning and coding before broad text searches when the question is semantic or structural.",
			promptSnippet: "Search the project semantic graph for implementations and dependencies",
			promptGuidelines: [
				"During planning and coding, proactively use graph_search to locate existing implementations, trace dependencies, and avoid duplicate abstractions.",
				"Verify graph-returned paths and symbols against current source before editing.",
			],
			parameters: Type.Object({
				query: Type.String({ minLength: 1, description: "Semantic or structural project question" }),
				maxEntryNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, default: 8 })),
				maxHops: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, default: 2 })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = await createClient(ctx.cwd).call("project_graph_search", {
					query: params.query,
					max_entry_nodes: params.maxEntryNodes ?? 8,
					max_hops: params.maxHops ?? 2,
				});
				return {
					content: [{ type: "text", text: JSON.stringify(result, undefined, 2) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			name: "graph_status",
			label: "Project graph status",
			description: "Inspect project graph freshness, index state, and background model configuration.",
			promptSnippet: "Inspect project graph freshness and index state",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const result = await createClient(ctx.cwd).call("project_graph_status", {});
				return {
					content: [{ type: "text", text: JSON.stringify(result, undefined, 2) }],
					details: result,
				};
			},
		});

		function stopPolling(): void {
			pollGeneration++;
			if (pollTimer) clearTimeout(pollTimer);
			pollTimer = undefined;
		}

		function applyStatus(payload: JsonRecord, ctx: ExtensionContext, announceCompletion: boolean): string {
			const job = jobFrom(payload);
			const state = stringValue(job.state) ?? "unknown";
			const progress = progressFrom(job);
			const phase = stringValue(progress?.phase);
			const message = stringValue(progress?.message);
			const measured = compactProgress(progress);
			const label = `graph ${state}${phase ? ` · ${formatPhase(phase)}` : ""}${measured ? ` · ${measured}` : ""}`;
			const color = state === "complete" ? "success" : state === "error" ? "error" : "accent";
			setGraphToolAvailability(true, graphIndexReady(payload));
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, label));
			if (state === "queued" || state === "running") {
				ctx.ui.setWidget(
					STATUS_WIDGET,
					[
						`GraphRAG is indexing in the background${measured ? ` · ${measured}` : ""}${message ? ` · ${message}` : ""}`,
					],
					{ placement: "aboveEditor" },
				);
			} else {
				ctx.ui.setWidget(STATUS_WIDGET, undefined);
			}
			const jobId = stringValue(job.job_id);
			if (announceCompletion && state === "complete" && jobId && completionAnnouncedFor !== jobId) {
				completionAnnouncedFor = jobId;
				ctx.ui.notify("GraphRAG index is ready.", "info");
			}
			if (announceCompletion && state === "error") {
				ctx.ui.notify(stringValue(job.error) ?? message ?? "GraphRAG indexing failed.", "error");
			}
			return state;
		}

		function schedulePolling(ctx: ExtensionContext): void {
			stopPolling();
			const generation = pollGeneration;
			const poll = async (): Promise<void> => {
				try {
					const payload = await createClient(ctx.cwd).call("project_graph_llm_index_status", {});
					if (generation !== pollGeneration) return;
					const state = applyStatus(payload, ctx, true);
					if (state !== "queued" && state !== "running") return;
				} catch {
					if (generation !== pollGeneration) return;
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "graph status unavailable"));
					ctx.ui.setWidget(STATUS_WIDGET, undefined);
					return;
				}
				pollTimer = setTimeout(() => void poll(), pollIntervalMs);
				pollTimer.unref();
			};
			pollTimer = setTimeout(() => void poll(), pollIntervalMs);
			pollTimer.unref();
		}

		pi.registerCommand("build_graph", {
			description: "Build the project GraphRAG index in the background",
			handler: async (_args, ctx) => {
				if (!ctx.isProjectTrusted()) {
					ctx.ui.notify("Trust the project before starting its GraphRAG indexer.", "error");
					return;
				}
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "graph starting"));
				ctx.ui.setWidget(STATUS_WIDGET, ["Starting GraphRAG in the background…"], { placement: "aboveEditor" });
				try {
					const payload = await createClient(ctx.cwd).call("project_graph_start_llm_index", {});
					const state = applyStatus(payload, ctx, false);
					ctx.ui.notify(
						state === "queued" || state === "running"
							? "GraphRAG indexing is running in the background. Use /index_status for details."
							: formatProjectGraphStatus(payload),
						"info",
					);
					if (state === "queued" || state === "running") schedulePolling(ctx);
				} catch (error) {
					stopPolling();
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "graph start failed"));
					ctx.ui.setWidget(STATUS_WIDGET, undefined);
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		pi.registerCommand("index_status", {
			description: "Show project GraphRAG indexing progress",
			handler: async (_args, ctx) => {
				try {
					const payload = await createClient(ctx.cwd).call("project_graph_llm_index_status", {});
					const state = applyStatus(payload, ctx, false);
					ctx.ui.notify(formatProjectGraphStatus(payload), state === "error" ? "error" : "info");
					if (state === "queued" || state === "running") schedulePolling(ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		pi.on("tool_execution_start", async (event, ctx) => {
			if (!graphToolName(event.toolName, "project_graph_start_llm_index")) return;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "graph starting"));
			ctx.ui.setWidget(STATUS_WIDGET, ["Starting GraphRAG in the background…"], { placement: "aboveEditor" });
		});

		pi.on("tool_execution_end", async (event, ctx) => {
			if (
				!graphToolName(event.toolName, "project_graph_start_llm_index") &&
				!graphToolName(event.toolName, "project_graph_llm_index_status")
			)
				return;
			if (event.isError) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "graph command failed"));
				ctx.ui.setWidget(STATUS_WIDGET, undefined);
				return;
			}
			const payload = toolPayload(event.result);
			if (!payload) return;
			const state = applyStatus(payload, ctx, true);
			if (state === "queued" || state === "running") schedulePolling(ctx);
		});

		pi.on("session_start", async (_event, ctx) => {
			try {
				const payload = await createClient(ctx.cwd).call("project_graph_llm_index_status", {});
				const state = applyStatus(payload, ctx, false);
				if (state === "queued" || state === "running") schedulePolling(ctx);
			} catch {
				setGraphToolAvailability(false, false);
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setWidget(STATUS_WIDGET, undefined);
			}
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			stopPolling();
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(STATUS_WIDGET, undefined);
		});
	};
}

export default createProjectGraphExtension();
