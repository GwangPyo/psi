import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { PlanMachineDefinition, PlanRuntimeSnapshot } from "../src/extensions/plan/fsm/index.ts";
import planModeExtension from "../src/extensions/plan/index.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function actionState(id: string, abstraction: "goal" | "implementation" | "verification") {
	return {
		id,
		kind: "action" as const,
		title: id,
		abstraction,
		role: abstraction === "verification" ? "verifier" : "implementer",
		instruction: `Complete ${id}`,
		acceptanceCriteria: [`${id} evidence exists`],
		errorPolicy: {
			strategy: "propagate" as const,
			mayHideFailure: false,
			suppressionAllowed: false,
			observableSignals: [`${id} failure`],
		},
	};
}

function createMachine(): PlanMachineDefinition {
	return {
		version: 1,
		id: "extension-plan",
		goal: "Connect PlanFSM to plan mode",
		initialStateId: "implement",
		parallelism: {
			strategy: "sequential",
			rationale: "Verification consumes the implementation result, so these actions must execute sequentially.",
			independentStateGroups: [],
		},
		context: { variables: {}, errorSuppression: "forbid" },
		states: [
			actionState("implement", "implementation"),
			actionState("verify", "verification"),
			{
				id: "done",
				kind: "final",
				title: "done",
				abstraction: "verification",
				role: "verifier",
				acceptanceCriteria: [],
				finalOutcome: "success",
			},
		],
		transitions: [
			{ id: "implemented", from: ["implement"], to: ["verify"], event: "SUCCESS" },
			{ id: "verified", from: ["verify"], to: ["done"], event: "SUCCESS" },
		],
		limits: { maxTransitions: 10, defaultMaxVisitsPerState: 2 },
	};
}

function setup(options: { selectChoice?: string; entries?: unknown[] } = {}) {
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

	async function emit(event: string, payload: unknown): Promise<unknown> {
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

describe("built-in PlanFSM extension", () => {
	it("animates the plan status while the agent is drafting", async () => {
		vi.useFakeTimers();
		try {
			const harness = setup();
			await harness.runCommand("plan");
			await harness.emit("agent_start", { type: "agent_start" });

			const setWidget = vi.mocked(harness.ctx.ui.setWidget);
			const draftingWidgets = () => setWidget.mock.calls.filter((call) => call[0] === "plan-drafting");
			expect(draftingWidgets().at(-1)?.[1]).toEqual(["⠋ plan drafting"]);
			expect(draftingWidgets().at(-1)?.[2]).toEqual({ placement: "aboveEditor" });

			vi.advanceTimersByTime(80);
			expect(draftingWidgets().at(-1)?.[1]).toEqual(["⠙ plan drafting"]);

			await harness.emit("agent_end", { type: "agent_end", messages: [] });
			expect(draftingWidgets().at(-1)?.[1]).toBeUndefined();
			expect(vi.mocked(harness.ctx.ui.setStatus).mock.calls.at(-1)?.[1]).toBe("plan drafting");
		} finally {
			vi.useRealTimers();
		}
	});

	it("submits a structured machine and executes it through persisted transitions", async () => {
		const harness = setup({ selectChoice: "Execute the plan" });
		await harness.runCommand("plan");

		expect(harness.activeTools()).toContain("submit_plan_machine");
		expect(harness.activeTools()).not.toContain("edit");
		expect(harness.activeTools()).not.toContain("plan_transition");

		await harness.executeTool("submit_plan_machine", createMachine());
		await harness.emit("agent_end", { type: "agent_end", messages: [] });

		expect(harness.activeTools()).toContain("plan_transition");
		expect(harness.activeTools()).not.toContain("submit_plan_machine");
		expect(harness.activeTools()).toContain("edit");
		expect(harness.api.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "plan-mode-execute" }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);

		await harness.executeTool("plan_transition", {
			event: "SUCCESS",
			sourceStateId: "implement",
			evidence: "implementation tests pass",
		});
		const runningState = harness.persisted.at(-1)?.data as { snapshot: PlanRuntimeSnapshot };
		expect(runningState.snapshot.status).toBe("running");
		expect(runningState.snapshot.activeStateIds).toEqual(["verify"]);
		expect(runningState.snapshot.history.at(-1)?.evidence).toBe("implementation tests pass");

		await harness.executeTool("plan_transition", {
			event: "SUCCESS",
			sourceStateId: "verify",
			evidence: "typecheck and regression test pass",
		});
		const completedState = harness.persisted.at(-1)?.data as { snapshot: PlanRuntimeSnapshot };
		expect(completedState.snapshot.status).toBe("completed");
		expect(harness.activeTools()).not.toContain("plan_transition");
		expect(harness.api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "plan-complete" }), {
			triggerTurn: false,
		});
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

	it("retains a partial submission and accepts the reported malformed argument shape", async () => {
		const harness = setup();
		await harness.runCommand("plan");
		const machine = createMachine();
		const partial = {
			version: 1 as const,
			id: machine.id,
			goal: machine.goal,
			initialStateId: machine.initialStateId,
			context: { variables: machine.context.variables },
			errorSuppression: "forbid" as const,
		};

		expect(harness.toolSchemaAccepts("submit_plan_machine", partial)).toBe(true);
		const firstResult = (await harness.executeTool("submit_plan_machine", partial)) as {
			content: Array<{ type: string; text: string }>;
			details: { accepted: boolean; missing: string[] };
		};
		expect(firstResult.details.accepted).toBe(false);
		expect(firstResult.details.missing).toEqual(["parallelism", "states", "transitions"]);
		expect(firstResult.content[0]?.text).toContain("previously supplied fields are retained");
		const planningContext = (await harness.emit("before_agent_start", {
			type: "before_agent_start",
		})) as { message?: { content?: string } };
		expect(planningContext.message?.content).toContain("Build the dependency graph before choosing an order");
		expect(planningContext.message?.content).toContain("parentId expresses conceptual ownership");
		expect(planningContext.message?.content).toContain("File proximity or planning convenience alone");
		expect(planningContext.message?.content).toContain("Still required: parallelism, states, transitions");

		const secondResult = (await harness.executeTool("submit_plan_machine", {
			parallelism: machine.parallelism,
			states: machine.states,
			transitions: machine.transitions,
		})) as {
			content: Array<{ type: string; text: string }>;
			details: { machine: PlanMachineDefinition };
		};
		expect(secondResult.content[0]?.text).toContain("PlanFSM accepted");
		expect(secondResult.details.machine.context.errorSuppression).toBe("forbid");
		expect(secondResult.details.machine.limits).toEqual({
			maxTransitions: 30,
			defaultMaxVisitsPerState: 3,
		});
	});

	it("restores a running PlanFSM from the persisted session entry", async () => {
		const first = setup({ selectChoice: "Execute the plan" });
		await first.runCommand("plan");
		await first.executeTool("submit_plan_machine", createMachine());
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
		})) as { message?: { content?: string } };

		expect(restored.activeTools()).toContain("plan_transition");
		expect(context.message?.content).toContain("verify: verify");
		expect(context.message?.content).toContain("verified: verify --SUCCESS--> done");
	});
});
