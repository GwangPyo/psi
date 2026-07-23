import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { PlanMachineDefinition, PlanRuntimeSnapshot } from "../src/extensions/plan/fsm/index.ts";
import planModeExtension from "../src/extensions/plan/index.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function setup(options: { confirmChoice?: boolean; selectChoice?: string; entries?: unknown[] } = {}) {
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
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry(customType: string, data: unknown) {
			persisted.push({ customType, data });
		},
	} as unknown as ExtensionAPI;

	planModeExtension(api);

	const ctx = {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(async () => options.confirmChoice ?? false),
			select: vi.fn(async () => options.selectChoice),
			editor: vi.fn(async () => undefined),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			theme: { fg: (_name: string, text: string) => text },
		},
		sessionManager: { getEntries: () => options.entries ?? [] },
	} as unknown as ExtensionContext;

	async function runCommand(name: string): Promise<void> {
		const command = commands.get(name);
		if (!command) throw new Error(`Missing command ${name}`);
		await command("", ctx);
	}

	async function executeTool(name: string, params: unknown): Promise<unknown> {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing tool ${name}`);
		return await tool.execute("call", params, undefined, undefined, ctx);
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
		runCommand,
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
	const result = (await harness.executeTool("guide_plan", { operation: "finalize" })) as {
		details: { machine: PlanMachineDefinition };
	};
	return result.details.machine;
}

describe("built-in PlanFSM extension", () => {
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
			branches: [action("backend"), action("frontend")],
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
			steps: [action("verify", "verification")],
		});
		await harness.executeTool("guide_plan", {
			operation: "add_final",
			id: "done",
			from: ["verify"],
		});
		const finalized = (await harness.executeTool("guide_plan", { operation: "finalize" })) as {
			details: { machine: PlanMachineDefinition };
		};

		expect(finalized.details.machine.parallelism).toMatchObject({
			strategy: "parallel",
			independentStateGroups: [["backend", "frontend"]],
		});
		expect(finalized.details.machine.initialStateId).toBe("implementation__fork");
		expect(finalized.details.machine.transitions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					from: ["implementation__fork"],
					to: ["backend", "frontend"],
					event: "AUTO",
				}),
				expect.objectContaining({
					from: ["implementation__join"],
					to: ["verify"],
					event: "AUTO",
				}),
			]),
		);
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

	it("keeps unresolved choices local instead of globally stopping guide expansion", async () => {
		const harness = setup({ confirmChoice: true });
		await harness.runCommand("plan");
		const context = (await harness.emit("before_agent_start")) as { message?: { content?: string } };

		expect(context.message?.content).toContain("Represent unresolved material decisions with add_choice");
		expect(context.message?.content).toContain("Continue expanding every independent frontier");
		expect(context.message?.content).not.toContain("Wait for the user's answer before moving to the next decision");
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
		const context = (await restored.emit("before_agent_start")) as { message?: { content?: string } };

		expect(restored.activeTools()).toContain("plan_transition");
		expect(context.message?.content).toContain("Treat every active action as a required postcondition");
		expect(context.message?.content).toContain("verify: verify");
	});
});
