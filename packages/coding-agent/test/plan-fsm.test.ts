import { describe, expect, it } from "vitest";
import {
	PlanFSM,
	PlanFSMValidationError,
	type PlanMachineDefinition,
	validatePlanMachine,
} from "../src/extensions/plan/fsm/index.ts";

function state(
	id: string,
	kind: PlanMachineDefinition["states"][number]["kind"] = "action",
): PlanMachineDefinition["states"][number] {
	return {
		id,
		kind,
		title: id,
		abstraction: kind === "final" ? "verification" : "implementation",
		role: kind === "final" ? "verifier" : "implementer",
		acceptanceCriteria: kind === "action" ? [`${id} completed`] : [],
		...(kind === "action"
			? {
					errorPolicy: {
						strategy: "propagate" as const,
						mayHideFailure: false,
						suppressionAllowed: false,
						observableSignals: [`${id} failure`],
					},
				}
			: {}),
		...(kind === "final" ? { finalOutcome: "success" as const } : {}),
	};
}

function machine(
	states: PlanMachineDefinition["states"],
	transitions: PlanMachineDefinition["transitions"],
	overrides: Partial<PlanMachineDefinition> = {},
): PlanMachineDefinition {
	return {
		version: 1,
		id: "test-plan",
		goal: "Test the Plan FSM",
		initialStateId: states[0]?.id ?? "missing",
		parallelism: {
			strategy: "sequential",
			rationale: "Every action in this fixture depends on the preceding action result.",
			independentStateGroups: [],
		},
		context: { variables: {}, errorSuppression: "forbid" },
		states,
		transitions,
		limits: { maxTransitions: 30, defaultMaxVisitsPerState: 5 },
		...overrides,
	};
}

describe("PlanFSM", () => {
	it("executes a linear plan and reaches a final state", () => {
		const definition = machine(
			[state("design"), state("implement"), state("done", "final")],
			[
				{ id: "design-complete", from: ["design"], to: ["implement"], event: "SUCCESS" },
				{ id: "implementation-complete", from: ["implement"], to: ["done"], event: "SUCCESS" },
			],
		);
		const fsm = new PlanFSM(definition);

		expect(fsm.start(1).activeStateIds).toEqual(["design"]);
		expect(fsm.dispatch("SUCCESS", { sourceStateId: "design", timestamp: 2 }).appliedTransitionIds).toEqual([
			"design-complete",
		]);
		const result = fsm.dispatch("SUCCESS", { sourceStateId: "implement", timestamp: 3 });

		expect(result.snapshot.status).toBe("completed");
		expect(result.snapshot.activeStateIds).toEqual(["done"]);
		expect(result.snapshot.completedStateIds).toEqual(["design", "implement"]);
	});

	it("selects a guarded branch deterministically", () => {
		const definition = machine(
			[state("decide", "choice"), state("fast"), state("safe"), state("done", "final")],
			[
				{
					id: "choose-fast",
					from: ["decide"],
					to: ["fast"],
					event: "DECIDE",
					guard: { mode: "all", conditions: [{ type: "context_equals", key: "mode", value: "fast" }] },
				},
				{
					id: "choose-safe",
					from: ["decide"],
					to: ["safe"],
					event: "DECIDE",
					guard: { mode: "all", conditions: [{ type: "context_not_equals", key: "mode", value: "fast" }] },
				},
				{ id: "fast-done", from: ["fast"], to: ["done"], event: "SUCCESS" },
				{ id: "safe-done", from: ["safe"], to: ["done"], event: "SUCCESS" },
			],
			{ context: { variables: { mode: "fast" }, errorSuppression: "forbid" } },
		);
		const fsm = new PlanFSM(definition);
		fsm.start();

		const result = fsm.dispatch("DECIDE", { sourceStateId: "decide" });

		expect(result.appliedTransitionIds).toEqual(["choose-fast"]);
		expect(result.snapshot.activeStateIds).toEqual(["fast"]);
	});

	it("forks independent branches and joins the DAG", () => {
		const definition = machine(
			[
				state("fork", "fork"),
				state("backend"),
				state("frontend"),
				state("backend-done"),
				state("frontend-done"),
				state("join", "join"),
				state("done", "final"),
			],
			[
				{ id: "split", from: ["fork"], to: ["backend", "frontend"], event: "START_BRANCHES" },
				{ id: "backend-complete", from: ["backend"], to: ["backend-done"], event: "SUCCESS" },
				{ id: "frontend-complete", from: ["frontend"], to: ["frontend-done"], event: "SUCCESS" },
				{
					id: "join-branches",
					from: ["backend-done", "frontend-done"],
					to: ["join"],
					event: "JOIN",
				},
				{ id: "integration-complete", from: ["join"], to: ["done"], event: "SUCCESS" },
			],
			{
				parallelism: {
					strategy: "parallel",
					rationale: "Backend and frontend work have independent inputs and can execute concurrently.",
					independentStateGroups: [["backend", "frontend"]],
				},
			},
		);
		const fsm = new PlanFSM(definition);
		fsm.start();

		expect(fsm.dispatch("START_BRANCHES").snapshot.activeStateIds).toEqual(["backend", "frontend"]);
		expect(fsm.dispatch("SUCCESS", { sourceStateId: "backend" }).snapshot.activeStateIds).toEqual([
			"backend-done",
			"frontend",
		]);
		expect(fsm.dispatch("JOIN").appliedTransitionIds).toEqual([]);
		expect(fsm.dispatch("SUCCESS", { sourceStateId: "frontend" }).snapshot.activeStateIds).toEqual([
			"backend-done",
			"frontend-done",
		]);
		expect(fsm.dispatch("JOIN").snapshot.activeStateIds).toEqual(["join"]);
		expect(fsm.dispatch("SUCCESS").snapshot.status).toBe("completed");
	});

	it("settles structural AUTO transitions without an agent control turn", () => {
		const definition = machine(
			[
				state("fork", "fork"),
				state("backend"),
				state("frontend"),
				state("backend-done", "checkpoint"),
				state("frontend-done", "checkpoint"),
				state("join", "join"),
				state("verify"),
				state("done", "final"),
			],
			[
				{ id: "split", from: ["fork"], to: ["backend", "frontend"], event: "AUTO" },
				{ id: "backend-complete", from: ["backend"], to: ["backend-done"], event: "SUCCESS" },
				{ id: "frontend-complete", from: ["frontend"], to: ["frontend-done"], event: "SUCCESS" },
				{ id: "join-branches", from: ["backend-done", "frontend-done"], to: ["join"], event: "AUTO" },
				{ id: "start-verification", from: ["join"], to: ["verify"], event: "AUTO" },
				{ id: "verified", from: ["verify"], to: ["done"], event: "SUCCESS" },
			],
			{
				parallelism: {
					strategy: "parallel",
					rationale: "Backend and frontend consume independent inputs and can progress concurrently.",
					independentStateGroups: [["backend", "frontend"]],
				},
			},
		);
		const fsm = new PlanFSM(definition);

		expect(fsm.start().activeStateIds).toEqual(["backend", "frontend"]);
		expect(fsm.dispatch("SUCCESS", { sourceStateId: "backend" }).snapshot.activeStateIds).toEqual([
			"backend-done",
			"frontend",
		]);
		const joined = fsm.dispatch("SUCCESS", { sourceStateId: "frontend" });
		expect(joined.snapshot.activeStateIds).toEqual(["verify"]);
		expect(joined.snapshot.history.map((record) => record.event)).toEqual([
			"START",
			"AUTO",
			"SUCCESS",
			"SUCCESS",
			"AUTO",
			"AUTO",
		]);
	});

	it("supports bounded loops and blocks when a state visit limit is exceeded", () => {
		const work = { ...state("work"), maxVisits: 2 };
		const definition = machine(
			[work, state("verify"), state("done", "final")],
			[
				{ id: "work-to-verify", from: ["work"], to: ["verify"], event: "SUCCESS" },
				{ id: "retry-work", from: ["verify"], to: ["work"], event: "FAILURE" },
				{ id: "verified", from: ["verify"], to: ["done"], event: "SUCCESS" },
			],
		);
		const fsm = new PlanFSM(definition);
		fsm.start();
		fsm.dispatch("SUCCESS", { sourceStateId: "work" });
		fsm.dispatch("FAILURE", { sourceStateId: "verify" });
		fsm.dispatch("SUCCESS", { sourceStateId: "work" });

		const result = fsm.dispatch("FAILURE", { sourceStateId: "verify" });

		expect(result.appliedTransitionIds).toEqual([]);
		expect(result.snapshot.status).toBe("blocked");
		expect(result.snapshot.blockReason).toBe('State "work" visit limit 2 exceeded.');
	});

	it("applies context effects and restores a runtime snapshot", () => {
		const definition = machine(
			[state("work"), state("done", "final")],
			[
				{
					id: "retry",
					from: ["work"],
					to: ["work"],
					event: "RETRY",
					effects: [{ type: "increment_context", key: "retries", by: 1 }],
				},
				{ id: "done", from: ["work"], to: ["done"], event: "SUCCESS" },
			],
			{ context: { variables: { retries: 0 }, errorSuppression: "forbid" } },
		);
		const fsm = new PlanFSM(definition);
		fsm.start();
		fsm.dispatch("RETRY");

		const restored = new PlanFSM(definition, fsm.snapshot);
		const result = restored.dispatch("SUCCESS");

		expect(result.snapshot.context.retries).toBe(1);
		expect(result.snapshot.status).toBe("completed");
	});

	it("rejects invalid references and unsafe error suppression", () => {
		const definition = machine(
			[
				{
					...state("work"),
					errorPolicy: {
						strategy: "suppress",
						mayHideFailure: true,
						suppressionAllowed: false,
						observableSignals: [],
					},
				},
				state("done", "final"),
			],
			[{ id: "broken", from: ["work"], to: ["missing"], event: "SUCCESS" }],
		);

		const validation = validatePlanMachine(definition);

		expect(validation.ok).toBe(false);
		expect(validation.errors).toContain('Transition "broken" references missing state "missing".');
		expect(validation.errors).toContain('State "work" may hide failures while error suppression is forbidden.');
		expect(() => new PlanFSM(definition)).toThrow(PlanFSMValidationError);
	});

	it("rejects a declared parallel group without a matching fork", () => {
		const definition = machine(
			[state("first"), state("second"), state("done", "final")],
			[
				{ id: "first-done", from: ["first"], to: ["second"], event: "SUCCESS" },
				{ id: "second-done", from: ["second"], to: ["done"], event: "SUCCESS" },
			],
			{
				parallelism: {
					strategy: "parallel",
					rationale: "The two action states use independent inputs and should execute concurrently.",
					independentStateGroups: [["first", "second"]],
				},
			},
		);

		const validation = validatePlanMachine(definition);

		expect(validation.ok).toBe(false);
		expect(validation.errors).toContain(
			"Parallel group 1 (first, second) must be activated by a multi-target transition from a fork state.",
		);
	});
});
