import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createProjectGraphExtension,
	formatProjectGraphStatus,
	type ProjectGraphClient,
	resolveProjectGraphServer,
} from "../src/extensions/project-graph/index.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type EventHandler = (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown;

function graphPayload(state: string, phase: string) {
	return {
		job: {
			job_id: "job-1",
			state,
			progress: {
				phase,
				workflow: state === "complete" ? "create_final_text_units" : "extract_graph",
				workflows_completed: state === "complete" ? 5 : 2,
				workflows_total: 5,
				operation: state === "complete" ? undefined : "extract graph progress",
				items_completed: state === "complete" ? undefined : 12,
				items_total: state === "complete" ? undefined : 48,
				message: state === "complete" ? "GraphRAG index is ready" : "Extracting code relationships",
			},
		},
		index: { state: state === "complete" ? "ready" : "absent" },
	};
}

function setup(responses: Record<string, unknown[]>) {
	const commands = new Map<string, CommandHandler>();
	const handlers = new Map<string, EventHandler>();
	const tools = new Map<string, unknown>();
	let activeTools = ["read", "graph_search", "graph_status"];
	const call = vi.fn(async (toolName: string) => {
		const values = responses[toolName];
		if (!values || values.length === 0) throw new Error(`No response for ${toolName}`);
		return values.shift() as Record<string, unknown>;
	});
	const client: ProjectGraphClient = { call };
	const api = {
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
		getActiveTools: () => activeTools.slice(),
		setActiveTools(toolNames: string[]) {
			activeTools = toolNames.slice();
		},
	} as unknown as ExtensionAPI;
	createProjectGraphExtension({ createClient: () => client, pollIntervalMs: 10 })(api);
	const ctx = {
		cwd: "/workspace/project",
		isProjectTrusted: () => true,
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;

	async function runCommand(name: string): Promise<void> {
		const command = commands.get(name);
		if (!command) throw new Error(`Missing command ${name}`);
		await command("", ctx);
	}

	async function emit(name: string, event: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Missing handler ${name}`);
		return await handler(event as never, ctx);
	}

	return { api, call, commands, ctx, emit, getActiveTools: () => activeTools.slice(), runCommand, tools };
}

describe("project graph extension", () => {
	it("starts GraphRAG in the background and displays persistent progress", async () => {
		const harness = setup({
			project_graph_start_llm_index: [graphPayload("running", "graphrag_workflows")],
		});

		await harness.runCommand("build_graph");
		expect(harness.getActiveTools()).toEqual(["read", "graph_status"]);

		expect(harness.commands.has("index_status")).toBe(true);
		expect(harness.call).toHaveBeenCalledWith("project_graph_start_llm_index", {});
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
			"project-graph",
			"graph running · graphrag workflows · 12/48 items",
		);
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith(
			"project-graph-indexing",
			["GraphRAG is indexing in the background · 12/48 items · Extracting code relationships"],
			{ placement: "aboveEditor" },
		);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"GraphRAG indexing is running in the background. Use /index_status for details.",
			"info",
		);
		await harness.emit("session_shutdown", { type: "session_shutdown" });
	});

	it("shows callback-reported workflow and item progress through /index_status", async () => {
		const payload = graphPayload("running", "graphrag_workflows");
		const harness = setup({ project_graph_llm_index_status: [payload] });

		await harness.runCommand("index_status");

		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Job: running\nPhase: graphrag workflows\nWorkflow: extract_graph (2/5 complete)\nOperation: extract graph progress (12/48 complete)\nDetail: Extracting code relationships\nJob ID: job-1\nIndex: absent",
			"info",
		);
		await harness.emit("session_shutdown", { type: "session_shutdown" });
	});

	it("polls until the background index is ready", async () => {
		vi.useFakeTimers();
		try {
			const harness = setup({
				project_graph_start_llm_index: [graphPayload("running", "graphrag_workflows")],
				project_graph_llm_index_status: [graphPayload("complete", "complete")],
			});
			await harness.runCommand("build_graph");
			await vi.advanceTimersByTimeAsync(10);

			expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
				"project-graph",
				"graph complete · complete · 5/5 workflows",
			);
			expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("project-graph-indexing", undefined);
			expect(harness.ctx.ui.notify).toHaveBeenCalledWith("GraphRAG index is ready.", "info");
			expect(harness.getActiveTools()).toEqual(["read", "graph_search", "graph_status"]);
			await harness.emit("session_shutdown", { type: "session_shutdown" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not activate graph search before the index is ready", async () => {
		const harness = setup({ project_graph_llm_index_status: [graphPayload("running", "graphrag_workflows")] });
		await harness.emit("session_start", { type: "session_start" });

		expect(harness.getActiveTools()).toEqual(["read", "graph_status"]);
		await harness.emit("session_shutdown", { type: "session_shutdown" });
	});

	it("removes graph tools when the backend is unavailable", async () => {
		const harness = setup({});
		await harness.emit("session_start", { type: "session_start" });

		expect(harness.getActiveTools()).toEqual(["read"]);
	});

	it("resolves the bundled backend without a project .pi/mcp.json", async () => {
		const projectRoot = join(process.cwd(), "project-without-pi-config");
		const config = await resolveProjectGraphServer(projectRoot);

		expect(config.args).toEqual(["-m", "project_graphrag.mcp_server"]);
		expect(config.env.PROJECT_GRAPHRAG_PROJECT_ROOT).toBe(projectRoot);
		expect(config.env.PYTHONPATH).toContain("project-graph/backend");
		const piCommand = JSON.parse(config.env.PROJECT_GRAPHRAG_PI_COMMAND) as unknown;
		expect(piCommand).toEqual(expect.arrayContaining([process.execPath]));
	});

	it("formats completed status without inventing missing fields", () => {
		expect(formatProjectGraphStatus(graphPayload("complete", "complete"))).toBe(
			"Job: complete\nPhase: complete\nWorkflow: create_final_text_units (5/5 complete)\nDetail: GraphRAG index is ready\nJob ID: job-1\nIndex: ready",
		);
	});
});
