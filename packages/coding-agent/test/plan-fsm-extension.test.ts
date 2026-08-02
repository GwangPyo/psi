import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	SpawnAgentOptions,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import {
	formatPlanMachine,
	type PlanMachineDefinition,
	type PlanRuntimeSnapshot,
} from "../src/extensions/plan/fsm/index.ts";
import planModeExtension from "../src/extensions/plan/index.ts";
import { PlanGraphComponent } from "../src/extensions/plan/tui-graph.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

const testCwdRoot = join(process.env.PI_TEST_SCRATCH ?? tmpdir(), `pi-plan-fsm-extension-${process.pid}`);
afterAll(async () => await rm(testCwdRoot, { recursive: true, force: true }));

function setup(
	options: {
		confirmChoice?: boolean;
		selectChoice?: string;
		editorAnswer?: string;
		entries?: unknown[];
		cwd?: string;
		model?: { provider: string; id: string };
		spawnAgent?: (options: Pick<SpawnAgentOptions, "systemPrompt" | "onEvent" | "afterToolCall">) => {
			prompt(message: string): Promise<string>;
			abort(): Promise<void>;
			appendUserMessage(message: string): Promise<void>;
			dispose(): void;
		};
	} = {},
) {
	let activeTools = ["read", "bash", "edit", "write", "echo_tool"];
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, EventHandler>();
	const persisted: Array<{ customType: string; data: unknown }> = [];

	const api = {
		registerFlag: vi.fn(),
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
			activeTools = [...activeTools, tool.name];
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		registerShortcut: vi.fn(),
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
		getFlag: vi.fn(() => false),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((toolNames: string[]) => {
			activeTools = [...toolNames];
		}),
		spawnAgent:
			options.spawnAgent ??
			(() => {
				throw new Error("Unexpected spawned agent");
			}),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry(customType: string, data: unknown) {
			persisted.push({ customType, data });
		},
	} as unknown as ExtensionAPI;

	planModeExtension(api);

	const ctx = {
		cwd: options.cwd ?? join(testCwdRoot, randomUUID()),
		model: options.model,
		modelRegistry: { find: vi.fn(() => undefined) },
		isProjectTrusted: () => true,
		getSystemPrompt: () => "main system prompt",
		hasUI: true,
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(async () => options.confirmChoice ?? false),
			select: vi.fn(async () => options.selectChoice),
			editor: vi.fn(async () => options.editorAnswer),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			theme: { fg: (_name: string, text: string) => text },
		},
		sessionManager: {
			getEntries: () => options.entries ?? [],
			buildSessionContext: () => ({ messages: [] }),
		},
	} as unknown as ExtensionContext;

	async function runCommand(name: string): Promise<void> {
		const command = commands.get(name);
		if (!command) throw new Error(`Missing command ${name}`);
		await command("", ctx);
	}

	async function executeTool(
		name: string,
		params: unknown,
		onUpdate?: Parameters<ToolDefinition["execute"]>[3],
	): Promise<unknown> {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing tool ${name}`);
		const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
		return await tool.execute("call", prepared, undefined, onUpdate, ctx);
	}

	function prepareToolArguments(name: string, params: unknown): unknown {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing tool ${name}`);
		return tool.prepareArguments ? tool.prepareArguments(params) : params;
	}

	function toolSchemaAccepts(name: string, params: unknown): boolean {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing tool ${name}`);
		return Compile(tool.parameters).Check(params);
	}

	async function emit(event: string, payload: unknown = { type: event }): Promise<unknown> {
		const handler = handlers.get(event);
		if (!handler) throw new Error(`Missing handler ${event}`);
		return await handler(payload, ctx);
	}

	return {
		activeTools: () => activeTools,
		api,
		ctx,
		emit,
		executeTool,
		persisted,
		prepareToolArguments,
		runCommand,
		tool: (name: string) => tools.get(name),
		toolSchemaAccepts,
	};
}

function action(id: string, abstraction: "implementation" | "verification" = "implementation") {
	return {
		id,
		title: id,
		objective: `Establish ${id}`,
		doneWhen: [`${id} evidence exists`],
		abstraction,
	};
}

function plainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

async function buildLinearGuide(harness: ReturnType<typeof setup>): Promise<PlanMachineDefinition> {
	await harness.executeTool("guide_plan", {
		operation: "start",
		id: "extension-plan",
		goal: "Connect the retained guide to execution",
	});
	await harness.executeTool("guide_plan", {
		operation: "add_sequence",
		steps: [action("implement"), action("verify", "verification")],
	});
	await harness.executeTool("guide_plan", {
		operation: "add_final",
		id: "done",
		from: ["verify"],
	});
	await completeReviewCycle(harness, "implement", {
		independentGroups: [],
		sequentialDependencies: [
			{
				before: "implement",
				after: "verify",
				reason: "Verification consumes the completed implementation artifact.",
			},
		],
	});
	const result = (await harness.executeTool("guide_plan", { operation: "finalize" })) as {
		details: { machine: PlanMachineDefinition };
	};
	return result.details.machine;
}

async function completeReviewCycle(
	harness: ReturnType<typeof setup>,
	stateId: string,
	dependencyAudit: {
		independentGroups: string[][];
		sequentialDependencies: Array<{ before: string; after: string; reason: string }>;
	},
): Promise<void> {
	for (const dimension of ["what", "how", "why", "when"] as const) {
		await harness.executeTool("guide_plan", {
			operation: "review",
			dimension,
			assessment: `${dimension} review found detail to strengthen`,
		});
		await harness.executeTool("guide_plan", {
			operation: "update_state",
			stateId,
			objective: `Establish ${stateId} after ${dimension} review`,
		});
		await harness.executeTool("guide_plan", {
			operation: "revise",
			summary: `Strengthened ${stateId} after ${dimension} review`,
			changedStateIds: [stateId],
		});
	}
	await harness.executeTool("guide_plan", {
		operation: "review_dependencies",
		assessment: "Classified every sibling task pair against concrete FSM dependencies.",
		...dependencyAudit,
	});
	await harness.executeTool("guide_plan", {
		operation: "update_state",
		stateId,
		doneWhen: [`${stateId} dependency-aware evidence exists`],
	});
	await harness.executeTool("guide_plan", {
		operation: "revise",
		summary: "Aligned task readiness and verification with the audited dependency topology.",
		changedStateIds: [stateId],
	});
}

describe("built-in PlanFSM extension", () => {
	it("persists scout input and output while displaying its investigation progress", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-scout-artifact-"));
		const prompt = vi.fn(async (_message: string) => "Found the relevant implementation in src/scout.ts.");
		const dispose = vi.fn();
		const spawnAgent = vi.fn((options: Pick<SpawnAgentOptions, "systemPrompt" | "onEvent">) => ({
			prompt: vi.fn(async (message: string) => {
				await options.onEvent?.({
					type: "tool_execution_start",
					toolCallId: "read-call",
					toolName: "read",
					args: { path: "src/scout.ts" },
				});
				await options.onEvent?.({
					type: "tool_execution_end",
					toolCallId: "read-call",
					toolName: "read",
					result: {},
					isError: false,
				});
				return await prompt(message);
			}),
			abort: vi.fn(async () => {}),
			appendUserMessage: vi.fn(async () => {}),
			dispose,
		}));
		const harness = setup({ cwd, model: { provider: "test", id: "scout" }, spawnAgent });
		const updates: string[] = [];

		try {
			const scoutResult = (await harness.executeTool(
				"scout",
				{ prompt: "Find the scout implementation." },
				(result) => {
					const content = result.content[0];
					if (content?.type === "text") updates.push(content.text);
				},
			)) as {
				details: { artifactId: string; artifactPath: string; status: string };
			};
			const { artifactId, artifactPath, status } = scoutResult.details;
			const serialized = await readFile(join(cwd, artifactPath), "utf8");
			const artifact = JSON.parse(serialized) as {
				input: { prompt: string };
				output: { status: string; text?: string };
			};

			expect(status).toBe("completed");
			expect(prompt).toHaveBeenCalledWith("Find the scout implementation.");
			expect(updates[0]).toContain("Scout test/scout is gathering information...");
			expect(updates).toContainEqual(expect.stringContaining("… read · src/scout.ts"));
			expect(updates.at(-1)).toContain("✓ read · src/scout.ts");
			expect(artifact).not.toHaveProperty("version");
			expect(artifact).not.toHaveProperty("artifactId");
			expect(artifact).not.toHaveProperty("createdAt");
			expect(artifact).not.toHaveProperty("model");
			expect(artifact.input.prompt).toBe("Find the scout implementation.");
			expect(artifact.output).toEqual({
				status: "completed",
				text: "Found the relevant implementation in src/scout.ts.",
			});
			expect(dispose).toHaveBeenCalledOnce();

			const readResult = (await harness.executeTool("read_scout_result", { artifactId })) as {
				content: Array<{ type: string; text?: string }>;
			};
			expect(readResult.content[0]).toMatchObject({ type: "text", text: serialized });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("warns a scout after the third identical read or grep, without sharing counters between scouts", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-scout-read-count-"));
		const outputsByScout: string[][] = [];
		const spawnAgent = vi.fn((options: Pick<SpawnAgentOptions, "afterToolCall">) => {
			const outputs: string[] = [];
			outputsByScout.push(outputs);
			const firstScout = outputsByScout.length === 1;
			const calls: Array<[string, { path: string; pattern?: string }]> = firstScout
				? [
						["read", { path: "src/repeated.ts" }],
						["read", { path: "src/repeated.ts" }],
						["read", { path: "src/repeated.ts" }],
						["grep", { path: "src", pattern: "repeated symbol" }],
						["grep", { path: "src", pattern: "repeated symbol" }],
						["grep", { path: "src", pattern: "repeated symbol" }],
					]
				: [
						["read", { path: "src/repeated.ts" }],
						["read", { path: "src/repeated.ts" }],
						["grep", { path: "src", pattern: "repeated symbol" }],
						["grep", { path: "src", pattern: "repeated symbol" }],
					];
			return {
				prompt: vi.fn(async () => {
					for (const [toolName, input] of calls) {
						const result = { content: [{ type: "text" as const, text: "tool output" }], details: {} };
						const patch = await options.afterToolCall?.({
							toolName,
							toolCallId: `${toolName}-${outputs.length}`,
							input,
							result,
							isError: false,
						});
						outputs.push(
							(patch?.content ?? result.content)
								.map((content) => (content.type === "text" ? content.text : ""))
								.join("\n"),
						);
					}
					return "Scout completed.";
				}),
				abort: vi.fn(async () => {}),
				appendUserMessage: vi.fn(async () => {}),
				dispose: vi.fn(),
			};
		});
		const harness = setup({ cwd, model: { provider: "test", id: "scout" }, spawnAgent });

		try {
			await harness.executeTool("scout", { prompt: "Inspect the repeated implementation." });
			await harness.executeTool("scout", { prompt: "Inspect it again in a fresh scout." });

			const warning =
				"Warning: you are repeatedly reading the same file. Read only the files that are truly necessary.";
			expect(outputsByScout[0]?.[0]).not.toContain(warning);
			expect(outputsByScout[0]?.[1]).not.toContain(warning);
			expect(outputsByScout[0]?.[2]).toContain(warning);
			expect(outputsByScout[0]?.[3]).not.toContain(warning);
			expect(outputsByScout[0]?.[4]).not.toContain(warning);
			expect(outputsByScout[0]?.[5]).toContain(warning);
			expect(outputsByScout[1]).toEqual(["tool output", "tool output", "tool output", "tool output"]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("lets a scout finish early through finish_scout and save its summary", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-scout-finish-"));
		let executeTool: ReturnType<typeof setup>["executeTool"] | undefined;
		const spawnAgent = vi.fn((options: { systemPrompt: string }) => ({
			prompt: vi.fn(async () => {
				const artifactId = /JSON artifact `([0-9a-f-]+)`/u.exec(options.systemPrompt)?.[1];
				if (!artifactId || !executeTool) throw new Error("Scout finish context was not initialized");
				const finished = (await executeTool("finish_scout", {
					artifactId,
					summary: "Found the relevant evidence in src/scout.ts.",
				})) as { terminate?: boolean };
				expect(finished.terminate).toBe(true);
				throw new Error("Spawned agent returned no text");
			}),
			abort: vi.fn(async () => {}),
			appendUserMessage: vi.fn(async () => {}),
			dispose: vi.fn(),
		}));
		const harness = setup({ cwd, model: { provider: "test", id: "scout" }, spawnAgent });
		executeTool = harness.executeTool;

		try {
			const result = (await harness.executeTool("scout", { prompt: "Find the scout implementation." })) as {
				details: { artifactId: string; artifactPath: string; status: string };
			};
			const serialized = await readFile(join(cwd, result.details.artifactPath), "utf8");
			const artifact = JSON.parse(serialized) as { output: { status: string; text?: string } };

			expect(result.details.status).toBe("completed");
			expect(artifact.output).toEqual({
				status: "completed",
				text: "Found the relevant evidence in src/scout.ts.",
			});
			expect(spawnAgent.mock.calls[0]?.[0].systemPrompt).toContain("finish_scout");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("stops a scout after three minutes and records the timeout", async () => {
		vi.useFakeTimers();
		const cwd = await mkdtemp(join(tmpdir(), "pi-scout-timeout-"));
		let rejectPrompt: ((error: Error) => void) | undefined;
		let resolvePromptStarted!: () => void;
		const promptStarted = new Promise<void>((resolve) => {
			resolvePromptStarted = resolve;
		});
		const abort = vi.fn(async () => rejectPrompt?.(new Error("aborted")));
		const spawnAgent = vi.fn((options: Pick<SpawnAgentOptions, "onEvent">) => ({
			prompt: vi.fn(async () => {
				await options.onEvent?.({
					type: "tool_execution_start",
					toolCallId: "read-call",
					toolName: "read",
					args: { path: "src/scout.ts", offset: 1, limit: 20 },
				});
				await options.onEvent?.({
					type: "tool_execution_end",
					toolCallId: "read-call",
					toolName: "read",
					result: { content: [{ type: "text", text: "scout implementation" }] },
					isError: false,
				});
				return await new Promise<string>((_resolve, reject) => {
					rejectPrompt = reject;
					resolvePromptStarted();
				});
			}),
			abort,
			appendUserMessage: vi.fn(async () => {}),
			dispose: vi.fn(),
		}));
		const harness = setup({ cwd, model: { provider: "test", id: "scout" }, spawnAgent });

		try {
			const resultPromise = harness.executeTool("scout", { prompt: "Keep investigating." }) as Promise<{
				details: { artifactId: string; artifactPath: string; status: string };
			}>;
			await promptStarted;
			await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
			const result = await resultPromise;
			const readResult = (await harness.executeTool("read_scout_result", {
				artifactId: result.details.artifactId,
			})) as { content: Array<{ type: string; text: string }> };
			const artifact = JSON.parse(readResult.content[0]!.text) as {
				readLogs: Array<{ input: unknown; output?: unknown; isError?: boolean }>;
				output: { status: string; error?: string };
			};

			expect(result.details.status).toBe("timed_out");
			expect(artifact.readLogs).toEqual([
				{
					input: { path: "src/scout.ts", offset: 1, limit: 20 },
					output: { content: [{ type: "text", text: "scout implementation" }] },
					isError: false,
				},
			]);
			expect(artifact.output).toEqual({ status: "timed_out", error: "Scout exceeded its 3-minute limit" });
			expect(abort).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("animates the plan status while the agent is drafting", async () => {
		vi.useFakeTimers();
		try {
			const harness = setup();
			await harness.runCommand("plan");
			await harness.emit("agent_start");

			const setWidget = vi.mocked(harness.ctx.ui.setWidget);
			const draftingWidgets = () => setWidget.mock.calls.filter((call) => call[0] === "plan-drafting");
			expect(draftingWidgets().at(-1)?.[1]).toEqual(["⠋ plan drafting"]);
			vi.advanceTimersByTime(80);
			expect(draftingWidgets().at(-1)?.[1]).toEqual(["⠙ plan drafting"]);

			await harness.emit("agent_end", { type: "agent_end", messages: [] });
			expect(draftingWidgets().at(-1)?.[1]).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders an accepted PlanFSM as a terminal-native graph instead of Mermaid", async () => {
		const harness = setup();
		await harness.runCommand("plan");
		const machine = await buildLinearGuide(harness);
		const lines = new PlanGraphComponent(machine, plainTheme(), { expanded: true }).render(52);
		const rendered = lines.join("\n");

		expect(harness.tool("guide_plan")?.renderResult).toBeTypeOf("function");
		expect(formatPlanMachine(machine)).not.toContain("mermaid");
		expect(formatPlanMachine(machine)).not.toContain("stateDiagram-v2");
		expect(rendered).toContain("PlanFSM accepted · sequential");
		expect(rendered).toContain("◆ START ─▶");
		expect(rendered).toContain("[implement]");
		expect(rendered).toContain("SUCCESS");
		expect(rendered).toContain("[verify]");
		expect(rendered).toContain("◆ END");
		expect(lines.every((line) => visibleWidth(line) <= 52)).toBe(true);
	});

	it("builds retained parallel topology without accepting a complete machine payload", async () => {
		const harness = setup();
		await harness.runCommand("plan");

		expect(harness.activeTools()).toContain("guide_plan");
		expect(harness.activeTools()).not.toContain("submit_plan_machine");
		expect(
			harness.toolSchemaAccepts("guide_plan", {
				version: 1,
				id: "dump",
				goal: "dump",
				states: [],
				transitions: [],
			}),
		).toBe(false);

		await harness.executeTool("guide_plan", {
			operation: "start",
			id: "parallel-plan",
			goal: "Build and verify two independent outcomes",
		});
		const parallelResult = (await harness.executeTool("guide_plan", {
			operation: "add_parallel",
			groupId: "implementation",
			branches: [
				{ ...action("backend"), parentId: "system" },
				{ ...action("frontend"), parentId: "system" },
			],
			rationale: "Backend and frontend consume separate contracts and have no producer-consumer dependency.",
		})) as { details: { status: { openStateIds: string[]; parallelGroups: string[][] } } };

		expect(parallelResult.details.status.openStateIds).toEqual(["implementation__join"]);
		expect(parallelResult.details.status.parallelGroups).toEqual([["backend", "frontend"]]);
		const prematureFinalize = (await harness.executeTool("guide_plan", { operation: "finalize" })) as {
			details: { accepted: boolean; errors: string[] };
		};
		expect(prematureFinalize.details.accepted).toBe(false);
		expect(prematureFinalize.details.errors[0]).toContain("implementation__join");

		await harness.executeTool("guide_plan", {
			operation: "add_sequence",
			after: ["implementation__join"],
			steps: [
				{ ...action("system"), abstraction: "system" },
				{ ...action("verify", "verification"), parentId: "system" },
			],
		});
		await harness.executeTool("guide_plan", {
			operation: "add_final",
			id: "done",
			from: ["verify"],
		});
		await completeReviewCycle(harness, "backend", {
			independentGroups: [["backend", "frontend"]],
			sequentialDependencies: [
				{
					before: "backend",
					after: "verify",
					reason: "Verification consumes the completed backend implementation.",
				},
				{
					before: "frontend",
					after: "verify",
					reason: "Verification consumes the completed frontend implementation.",
				},
			],
		});
		const finalized = (await harness.executeTool("guide_plan", { operation: "finalize" })) as {
			details: { machine: PlanMachineDefinition };
		};

		expect(finalized.details.machine.parallelism).toMatchObject({
			strategy: "parallel",
			independentStateGroups: [["backend", "frontend"]],
		});
		expect(finalized.details.machine.initialStateId).toBe("implementation__fork");
		expect(finalized.details.machine.states).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "backend", parentId: "system" })]),
		);
		expect(finalized.details.machine.transitions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					from: ["implementation__fork"],
					to: ["backend", "frontend"],
					event: "AUTO",
				}),
				expect.objectContaining({
					from: ["implementation__join"],
					to: ["system"],
					event: "AUTO",
				}),
			]),
		);
		const graph = new PlanGraphComponent(finalized.details.machine, plainTheme()).render(64).join("\n");
		expect(graph).toContain("ALL OF");
		expect(graph).toContain("[backend]");
		expect(graph).toContain("[frontend]");
		expect(graph).toContain("implementation__join");
	});

	it("requires ordered reviews, a concrete revision, and FSM-level parallel dependency topology", async () => {
		const harness = setup();
		await harness.runCommand("plan");
		await harness.executeTool("guide_plan", {
			operation: "start",
			id: "dependency-review",
			goal: "Detect accidental serialization",
		});
		await harness.executeTool("guide_plan", {
			operation: "add_sequence",
			steps: [action("backend"), action("frontend"), action("verify", "verification")],
		});
		await harness.executeTool("guide_plan", {
			operation: "add_final",
			id: "done",
			from: ["verify"],
		});

		await expect(
			harness.executeTool("guide_plan", {
				operation: "review",
				dimension: "how",
				assessment: "Skipped what",
			}),
		).rejects.toThrow('Review "what" next');

		await harness.executeTool("guide_plan", {
			operation: "review",
			dimension: "what",
			assessment: "Scope needs a more precise backend contract.",
		});
		await expect(
			harness.executeTool("guide_plan", {
				operation: "revise",
				dimension: "what",
				summary: "Claimed a revision without changing the FSM.",
			}),
		).rejects.toThrow("requires at least one state or topology mutation");
		await expect(
			harness.executeTool("guide_plan", {
				operation: "update_state",
				stateId: "backend",
			}),
		).rejects.toThrow("did not change any PlanFSM field");
		await harness.executeTool("guide_plan", {
			operation: "update_state",
			stateId: "backend",
			objective: "Establish the backend contract",
		});
		await harness.executeTool("guide_plan", {
			operation: "revise",
			dimension: "what",
			summary: "Made the backend contract explicit.",
			changedStateIds: ["backend"],
		});

		for (const dimension of ["how", "why", "when"] as const) {
			await harness.executeTool("guide_plan", {
				operation: "review",
				dimension,
				assessment: `${dimension} assessment`,
			});
			await harness.executeTool("guide_plan", {
				operation: "update_state",
				stateId: "backend",
				objective: `Establish backend after ${dimension}`,
			});
			await harness.executeTool("guide_plan", {
				operation: "revise",
				dimension,
				summary: `${dimension} revision`,
			});
		}

		await harness.executeTool("guide_plan", {
			operation: "review_dependencies",
			assessment: "Backend and frontend do not consume one another's outputs.",
			independentGroups: [["backend", "frontend"]],
			sequentialDependencies: [
				{
					before: "backend",
					after: "verify",
					reason: "Verification consumes the completed backend implementation.",
				},
				{
					before: "frontend",
					after: "verify",
					reason: "Verification consumes the completed frontend implementation.",
				},
			],
		});
		await harness.executeTool("guide_plan", {
			operation: "update_state",
			stateId: "backend",
			doneWhen: ["Backend contract evidence exists"],
		});
		await expect(
			harness.executeTool("guide_plan", {
				operation: "revise",
				dimension: "how",
				summary: "Parallelized independent work.",
			}),
		).rejects.toThrow("must not be serialized by an FSM path");

		await harness.executeTool("guide_plan", {
			operation: "remove_transition",
			transitionId: "guide_t1",
		});
		await harness.executeTool("guide_plan", {
			operation: "remove_transition",
			transitionId: "guide_t2",
		});
		await harness.executeTool("guide_plan", {
			operation: "set_initial",
			stateId: null,
		});
		await harness.executeTool("guide_plan", { operation: "remove_state", stateId: "backend" });
		await harness.executeTool("guide_plan", { operation: "remove_state", stateId: "frontend" });
		await harness.executeTool("guide_plan", {
			operation: "add_parallel",
			groupId: "forced",
			branches: [action("backend"), action("frontend")],
			rationale: "Backend and frontend have no producer-consumer dependency and must start together.",
		});
		await harness.executeTool("guide_plan", {
			operation: "connect",
			from: ["forced__join"],
			to: ["verify"],
			event: "AUTO",
		});
		await expect(
			harness.executeTool("guide_plan", {
				operation: "revise",
				dimension: "how",
				summary: "Replaced the accidental serial chain with a fork/join frontier.",
				changedStateIds: ["backend", "frontend"],
			}),
		).resolves.toBeDefined();

		const finalized = (await harness.executeTool("guide_plan", { operation: "finalize" })) as {
			details: { machine: PlanMachineDefinition };
		};
		expect(finalized.details.machine.parallelism.strategy).toBe("parallel");
		expect(finalized.details.machine.initialStateId).toBe("forced__fork");
	});

	it("accepts justified sequential dependency chains across parent and abstraction boundaries", async () => {
		const harness = setup();
		await harness.runCommand("plan");
		await harness.executeTool("guide_plan", {
			operation: "start",
			id: "cross-boundary-dependencies",
			goal: "Keep valid dependency chains across the plan hierarchy",
		});
		await harness.executeTool("guide_plan", {
			operation: "add_sequence",
			steps: [
				{ ...action("system"), abstraction: "system" },
				{ ...action("quality"), abstraction: "system", parentId: "system" },
				{ ...action("implement_core_logic"), parentId: "system" },
				{ ...action("implement_unit_tests", "verification"), parentId: "quality" },
				{ ...action("implement_curses_ui"), parentId: "system" },
				{ ...action("verify_game", "verification"), parentId: "quality" },
			],
		});
		await harness.executeTool("guide_plan", {
			operation: "add_final",
			id: "done",
			from: ["verify_game"],
		});

		await completeReviewCycle(harness, "implement_core_logic", {
			independentGroups: [],
			sequentialDependencies: [
				{
					before: "implement_core_logic",
					after: "implement_unit_tests",
					reason: "Unit tests consume the completed core game contract.",
				},
				{
					before: "implement_unit_tests",
					after: "implement_curses_ui",
					reason: "The UI consumes behavior stabilized by the core unit tests.",
				},
				{
					before: "implement_curses_ui",
					after: "verify_game",
					reason: "End-to-end verification consumes the completed curses UI.",
				},
			],
		});

		const finalized = (await harness.executeTool("guide_plan", { operation: "finalize" })) as {
			details: { machine: PlanMachineDefinition };
		};
		expect(finalized.details.machine.id).toBe("cross-boundary-dependencies");
		expect(finalized.details.machine.parallelism.strategy).toBe("sequential");
	});

	it("starts execution only after settlement and keeps driving a running frontier", async () => {
		const harness = setup({ selectChoice: "Execute the plan" });
		await harness.runCommand("plan");
		await buildLinearGuide(harness);
		await harness.emit("agent_end", { type: "agent_end", messages: [] });

		expect(harness.activeTools()).toContain("plan_transition");
		expect(harness.activeTools()).not.toContain("guide_plan");
		expect(harness.api.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "plan-mode-execute" }),
			expect.objectContaining({ triggerTurn: true }),
		);

		await harness.emit("agent_settled");
		expect(harness.api.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "plan-mode-execute" }),
			{ triggerTurn: true },
		);

		await harness.emit("agent_start");
		await harness.executeTool("plan_transition", {
			event: "SUCCESS",
			sourceStateId: "implement",
			evidence: "implementation tests pass",
		});
		await harness.emit("agent_end", { type: "agent_end", messages: [] });
		await harness.emit("agent_settled");

		const continuationCalls = vi
			.mocked(harness.api.sendMessage)
			.mock.calls.filter(([message, options]) => message.customType === "plan-mode-execute" && options?.triggerTurn);
		expect(continuationCalls).toHaveLength(2);
		const runningState = harness.persisted.at(-1)?.data as { snapshot: PlanRuntimeSnapshot };
		expect(runningState.snapshot.activeStateIds).toEqual(["verify"]);
	});

	it("blocks a running execution after two agent runs without state progress", async () => {
		const harness = setup({ selectChoice: "Execute the plan" });
		await harness.runCommand("plan");
		await buildLinearGuide(harness);
		await harness.emit("agent_end", { type: "agent_end", messages: [] });
		await harness.emit("agent_settled");

		await harness.emit("agent_start");
		await harness.emit("agent_end", { type: "agent_end", messages: [] });
		await harness.emit("agent_settled");
		await harness.emit("agent_start");
		await harness.emit("agent_end", { type: "agent_end", messages: [] });

		const blocked = harness.persisted.at(-1)?.data as { snapshot: PlanRuntimeSnapshot };
		expect(blocked.snapshot.status).toBe("blocked");
		expect(blocked.snapshot.blockReason).toContain("ended twice without advancing");
		expect(harness.activeTools()).not.toContain("plan_transition");
	});

	it("injects the separate top-down question-and-revise instructions as a system prompt", async () => {
		const harness = setup();
		await harness.runCommand("plan");
		const context = (await harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "plan this",
			systemPrompt: "base prompt",
			systemPromptOptions: {},
		})) as { systemPrompt?: string };

		expect(context.systemPrompt).toContain("base prompt");
		expect(context.systemPrompt).toContain("Top-down planning method");
		expect(context.systemPrompt).toContain("### What");
		expect(context.systemPrompt).toContain("### How");
		expect(context.systemPrompt).toContain("### Why");
		expect(context.systemPrompt).toContain("### When");
		expect(context.systemPrompt).toContain("Final task-dependency audit");
		expect(context.systemPrompt).toContain("constructing an executable PlanFSM with `guide_plan`");
		expect(context.systemPrompt).toContain(
			"Every successful `guide_plan` result returns a newer authoritative snapshot",
		);
		expect(context.systemPrompt).toContain("Never read or search repository source code");
		expect(harness.activeTools()).toContain("guide_plan");
		expect(harness.activeTools()).not.toContain("plan_transition");
		expect(context.systemPrompt).not.toContain("PlanFSM execution mode");
		expect(context.systemPrompt).not.toContain("plan_transition");
		expect(context.systemPrompt).not.toContain("guide_plan.system");
		expect(context).not.toHaveProperty("message");
	});

	it("grounds every guide call in the retained FSM and one next required action", async () => {
		const harness = setup();
		await harness.runCommand("plan");
		const started = (await harness.executeTool("guide_plan", {
			operation: "start",
			id: "grounded-plan",
			goal: "Keep every planning call grounded in retained state",
		})) as { content: Array<{ type: string; text: string }>; details: { accepted: boolean } };

		expect(started.details.accepted).toBe(true);
		expect(started.content[0]?.text).toContain("Authoritative retained FSM:");
		expect(started.content[0]?.text).toContain("Next required action:");
		expect(started.content[0]?.text).toContain("Build the macro topology next");
		expect(started.content[0]?.text).toContain("Never search project files for guide_plan examples");

		const topology = (await harness.executeTool("guide_plan", {
			operation: "add_sequence",
			steps: [action("implement")],
		})) as { content: Array<{ type: string; text: string }> };
		expect(topology.content[0]?.text).toContain("- implement [action/implementation]");
		expect(topology.content[0]?.text).toContain("Close or expand the retained frontier [implement]");

		await harness.executeTool("guide_plan", {
			operation: "add_final",
			id: "done",
			from: ["implement"],
		});
		const reviewed = (await harness.executeTool("guide_plan", {
			operation: "review",
			dimension: "what",
			assessment: "The implementation evidence needs a more concrete objective.",
		})) as { content: Array<{ type: string; text: string }> };
		expect(reviewed.content[0]?.text).toContain('retained "what" review is pending');
		expect(reviewed.content[0]?.text).toContain("do not call review, revise, or finalize yet");
		await expect(
			harness.executeTool("guide_plan", {
				operation: "revise",
				summary: "Tried to revise without changing retained state.",
			}),
		).rejects.toThrow("Authoritative retained FSM:");

		const mutated = (await harness.executeTool("guide_plan", {
			operation: "update_state",
			stateId: "implement",
			objective: "Implement the grounded contract and preserve observable evidence.",
		})) as { content: Array<{ type: string; text: string }> };
		expect(mutated.content[0]?.text).toContain('Complete the retained "what" review now');
		expect(mutated.content[0]?.text).toContain('{"operation":"revise","summary":"..."');

		const revised = (await harness.executeTool("guide_plan", {
			operation: "revise",
			dimension: "dependencies",
			summary: "Grounded the implementation objective in observable evidence.",
			changedStateIds: ["implement"],
		})) as { content: Array<{ type: string; text: string }> };
		expect(revised.content[0]?.text).toContain('{"operation":"review","dimension":"how"');
	});

	it("normalizes modify_state calls to the minimal update_state contract before validation", async () => {
		const harness = setup();
		await harness.runCommand("plan");
		await harness.executeTool("guide_plan", {
			operation: "start",
			id: "tetris",
			goal: "Implement Tetris",
		});
		await harness.executeTool("guide_plan", {
			operation: "add_sequence",
			steps: [action("implement_core_logic")],
		});

		const rawArguments = {
			operation: "modify_state",
			stateId: "implement_core_logic",
			title: "Implement Core Tetris Logic",
			objective: "Implement the core Tetris logic without UI dependencies.",
			doneWhen: ["tetris_logic.py contains the verified core game behavior."],
			abstraction: "component",
		};
		const prepared = harness.prepareToolArguments("guide_plan", rawArguments);

		expect(prepared).toEqual({ ...rawArguments, operation: "update_state" });
		expect(harness.toolSchemaAccepts("guide_plan", prepared)).toBe(true);
		await expect(harness.executeTool("guide_plan", rawArguments)).resolves.toBeDefined();
	});

	it("normalizes visible-failure aliases in every guide action shape before validation", async () => {
		const harness = setup();
		await harness.runCommand("plan");

		const errorPolicy = {
			strategy: "fail",
			mayHideFailure: false,
			suppressionAllowed: false,
			observableSignals: ["failure_observed"],
		};
		const sequence = harness.prepareToolArguments("guide_plan", {
			operation: "add_sequence",
			steps: [{ ...action("sequence"), errorPolicy }],
		});
		const parallel = harness.prepareToolArguments("guide_plan", {
			operation: "add_parallel",
			groupId: "parallel",
			branches: [
				{ ...action("left"), errorPolicy },
				{ ...action("right"), errorPolicy: { ...errorPolicy, strategy: "PROPAGATE" } },
			],
			rationale: "The branches have no producer-consumer dependency and can execute independently.",
		});
		const choice = harness.prepareToolArguments("guide_plan", {
			operation: "add_choice",
			choiceId: "choice",
			title: "Choose a route",
			branches: [
				{ event: "LEFT", step: { ...action("left"), errorPolicy } },
				{ event: "RIGHT", step: action("right") },
			],
		});
		const update = harness.prepareToolArguments("guide_plan", {
			operation: "update_state",
			stateId: "sequence",
			errorPolicy: { ...errorPolicy, strategy: "throw" },
		});

		expect(sequence).toMatchObject({ steps: [{ errorPolicy: { strategy: "propagate" } }] });
		expect(parallel).toMatchObject({
			branches: [{ errorPolicy: { strategy: "propagate" } }, { errorPolicy: { strategy: "propagate" } }],
		});
		expect(choice).toMatchObject({
			branches: [{ step: { errorPolicy: { strategy: "propagate" } } }, {}],
		});
		expect(update).toMatchObject({ errorPolicy: { strategy: "propagate" } });
		for (const prepared of [sequence, parallel, choice, update]) {
			expect(harness.toolSchemaAccepts("guide_plan", prepared)).toBe(true);
		}
	});

	it("accepts verification tasks in parallel dependency groups without changing their abstraction", async () => {
		const harness = setup();
		await harness.runCommand("plan");
		await harness.executeTool("guide_plan", {
			operation: "start",
			id: "parallel-verification",
			goal: "Run independent implementation and verification work concurrently",
		});
		await harness.executeTool("guide_plan", {
			operation: "add_parallel",
			groupId: "work",
			branches: [action("implement_ui"), action("verify_core", "verification")],
			rationale: "UI implementation and core verification consume separate artifacts and can run concurrently.",
		});
		await harness.executeTool("guide_plan", {
			operation: "add_final",
			id: "done",
			from: ["work__join"],
		});
		await completeReviewCycle(harness, "implement_ui", {
			independentGroups: [["implement_ui", "verify_core"]],
			sequentialDependencies: [],
		});

		const result = (await harness.executeTool("guide_plan", { operation: "finalize" })) as {
			details: { machine: PlanMachineDefinition };
		};
		expect(result.details.machine.states).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "verify_core", abstraction: "verification" })]),
		);
		expect(result.details.machine.parallelism.independentStateGroups).toEqual([["implement_ui", "verify_core"]]);
	});

	it("keeps the grill gate locked across questions until the agent completes it", async () => {
		const harness = setup({
			confirmChoice: true,
			selectChoice: "Other (type a custom answer)",
			editorAnswer: "Preserve the public API.",
		});
		await harness.runCommand("plan");

		expect(harness.activeTools()).toEqual(expect.arrayContaining(["plan_grill", "finish_grill"]));
		await expect(
			harness.executeTool("guide_plan", {
				operation: "start",
				id: "blocked",
				goal: "Must be grilled first",
			}),
		).rejects.toThrow("Planning grill is still active");

		const context = (await harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "plan this",
			systemPrompt: "base prompt",
			systemPromptOptions: {},
		})) as { systemPrompt?: string };
		expect(context.systemPrompt).toContain("mandatory grill session and topology is locked");
		expect(context.systemPrompt).toContain("finish_grill");

		const answer = (await harness.executeTool("plan_grill", {
			question: "Which compatibility boundary must remain stable?",
			choices: ["Public API", "Stored data"],
		})) as { details: { answer?: string } };
		expect(answer.details.answer).toBe("Preserve the public API.");
		await harness.executeTool("plan_grill", {
			question: "Which failure mode is acceptable?",
		});
		await expect(
			harness.executeTool("guide_plan", {
				operation: "start",
				id: "still-blocked",
				goal: "Use the grill answers",
			}),
		).rejects.toThrow("Planning grill is still active");

		await harness.executeTool("finish_grill", {
			rationale: "Both compatibility and failure-policy branches are resolved.",
		});
		await expect(
			harness.executeTool("guide_plan", {
				operation: "start",
				id: "unlocked",
				goal: "Use the grill answers",
			}),
		).resolves.toBeDefined();
	});

	it("serializes the grill conversation and finalized FSM under .psi, then loads it through /plan", async () => {
		const cwd = join(testCwdRoot, randomUUID());
		const first = setup({
			cwd,
			confirmChoice: true,
			selectChoice: "Other (type a custom answer)",
			editorAnswer: "Preserve the public API.",
		});
		await first.runCommand("plan");
		await first.executeTool("plan_grill", {
			question: "Which compatibility boundary must remain stable?",
			choices: ["Public API", "Stored data"],
		});
		await first.executeTool("finish_grill", { rationale: "The compatibility boundary is resolved." });
		const machine = await buildLinearGuide(first);
		const serialized = JSON.parse(await readFile(join(cwd, ".psi", "plan.json"), "utf8")) as {
			grill: Array<{ question: string; choices?: string[]; answer: string | null }>;
			plan: PlanMachineDefinition;
		};
		expect(serialized.grill).toEqual([
			{
				question: "Which compatibility boundary must remain stable?",
				choices: ["Public API", "Stored data"],
				answer: "Preserve the public API.",
			},
		]);
		expect(serialized.plan.id).toBe(machine.id);

		const loaded = setup({ cwd, selectChoice: "Load serialized plan" });
		await loaded.runCommand("plan");
		expect(loaded.activeTools()).toContain("guide_plan");
		expect(loaded.persisted.at(-1)?.data).toMatchObject({
			enabled: true,
			grillCompleted: true,
			machine: { id: machine.id },
		});

		await writeFile(join(cwd, ".psi", "plan.json"), JSON.stringify({ grill: {}, plan: serialized.plan }));
		const rejected = setup({ cwd });
		await rejected.runCommand("plan");
		expect(rejected.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Stored plan cannot be loaded"),
			"warning",
		);
	});

	it("lets the user explicitly complete the grill", async () => {
		const harness = setup({ confirmChoice: true });
		await harness.runCommand("plan");
		await harness.runCommand("grillcomplete");

		await expect(
			harness.executeTool("guide_plan", {
				operation: "start",
				id: "user-unlocked",
				goal: "Respect explicit user completion",
			}),
		).resolves.toBeDefined();
	});

	it("does not derive a plan from numbered assistant text", async () => {
		const harness = setup();
		await harness.runCommand("plan");
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: "Plan:\n1. Edit code\n2. Run tests" }],
		});

		expect(harness.ctx.ui.select).not.toHaveBeenCalled();
	});

	it("restores a running PlanFSM and its execution contract", async () => {
		const first = setup({ selectChoice: "Execute the plan" });
		await first.runCommand("plan");
		await buildLinearGuide(first);
		await first.emit("agent_end", { type: "agent_end", messages: [] });
		await first.executeTool("plan_transition", {
			event: "SUCCESS",
			sourceStateId: "implement",
			evidence: "implementation completed",
		});
		const state = first.persisted.at(-1);

		const restored = setup({
			entries: [{ type: "custom", customType: "plan-mode", data: state?.data }],
		});
		await restored.emit("session_start", { type: "session_start" });
		const context = (await restored.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "continue",
			systemPrompt: "base prompt",
			systemPromptOptions: {},
		})) as { systemPrompt?: string; message?: { content?: string } };

		expect(restored.activeTools()).toContain("plan_transition");
		expect(restored.activeTools()).not.toContain("guide_plan");
		expect(restored.activeTools()).not.toContain("plan_grill");
		expect(context.systemPrompt).toContain("base prompt");
		expect(context.systemPrompt).toContain("PlanFSM execution mode");
		expect(context.systemPrompt).toContain("Treat every active action as a required postcondition");
		expect(context.systemPrompt).toContain("verify: verify");
		expect(context.systemPrompt).toContain("plan_transition");
		expect(context.systemPrompt).not.toContain("Top-down planning method");
		expect(context.systemPrompt).not.toContain("guide_plan");
		expect(context).not.toHaveProperty("message");
	});
});
