import { type Static, Type } from "typebox";

const NonEmptyString = Type.String({ minLength: 1 });
const StateIdArray = Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true });

export const PlanScalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

export const PlanGuardConditionSchema = Type.Union([
	Type.Object({ type: Type.Literal("context_equals"), key: NonEmptyString, value: PlanScalarSchema }),
	Type.Object({ type: Type.Literal("context_not_equals"), key: NonEmptyString, value: PlanScalarSchema }),
	Type.Object({ type: Type.Literal("context_truthy"), key: NonEmptyString }),
	Type.Object({ type: Type.Literal("state_active"), stateId: NonEmptyString }),
	Type.Object({ type: Type.Literal("state_completed"), stateId: NonEmptyString }),
	Type.Object({
		type: Type.Literal("visit_count_lt"),
		stateId: NonEmptyString,
		value: Type.Integer({ minimum: 1 }),
	}),
	Type.Object({ type: Type.Literal("transition_count_lt"), value: Type.Integer({ minimum: 1 }) }),
]);

export const PlanGuardSchema = Type.Object({
	mode: Type.Union([Type.Literal("all"), Type.Literal("any")]),
	conditions: Type.Array(PlanGuardConditionSchema, { minItems: 1 }),
});

export const PlanEffectSchema = Type.Union([
	Type.Object({ type: Type.Literal("set_context"), key: NonEmptyString, value: PlanScalarSchema }),
	Type.Object({ type: Type.Literal("increment_context"), key: NonEmptyString, by: Type.Number() }),
]);

export const PlanErrorPolicySchema = Type.Object({
	strategy: Type.Union([
		Type.Literal("propagate"),
		Type.Literal("translate"),
		Type.Literal("retry"),
		Type.Literal("fallback"),
		Type.Literal("suppress"),
	]),
	mayHideFailure: Type.Boolean(),
	suppressionAllowed: Type.Boolean(),
	justification: Type.Optional(NonEmptyString),
	observableSignals: Type.Array(NonEmptyString, { uniqueItems: true }),
	retryLimit: Type.Optional(Type.Integer({ minimum: 1 })),
	fallbackStateId: Type.Optional(NonEmptyString),
});

export const PlanStateSchema = Type.Object({
	id: NonEmptyString,
	kind: Type.Union([
		Type.Literal("action"),
		Type.Literal("choice"),
		Type.Literal("fork"),
		Type.Literal("join"),
		Type.Literal("checkpoint"),
		Type.Literal("final"),
	]),
	title: NonEmptyString,
	abstraction: Type.Union([
		Type.Literal("goal"),
		Type.Literal("system"),
		Type.Literal("component"),
		Type.Literal("implementation"),
		Type.Literal("verification"),
	]),
	role: NonEmptyString,
	parentId: Type.Optional(NonEmptyString),
	instruction: Type.Optional(NonEmptyString),
	acceptanceCriteria: Type.Array(NonEmptyString, { uniqueItems: true }),
	errorPolicy: Type.Optional(PlanErrorPolicySchema),
	maxVisits: Type.Optional(Type.Integer({ minimum: 1 })),
	finalOutcome: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("blocked")])),
});

export const PlanTransitionSchema = Type.Object({
	id: NonEmptyString,
	from: StateIdArray,
	to: StateIdArray,
	event: NonEmptyString,
	guard: Type.Optional(PlanGuardSchema),
	effects: Type.Optional(Type.Array(PlanEffectSchema)),
	priority: Type.Optional(Type.Integer()),
});

export const PlanParallelismSchema = Type.Object({
	strategy: Type.Union([Type.Literal("parallel"), Type.Literal("sequential")]),
	rationale: Type.String({
		minLength: 20,
		description: "Concrete dependency analysis explaining which work can run concurrently and which must wait",
	}),
	independentStateGroups: Type.Array(Type.Array(NonEmptyString, { minItems: 2, uniqueItems: true }), {
		description: "Groups of branch-entry action states that have no dependency on one another",
	}),
});

export const PlanMachineSchema = Type.Object({
	version: Type.Literal(1),
	id: NonEmptyString,
	goal: NonEmptyString,
	initialStateId: NonEmptyString,
	parallelism: PlanParallelismSchema,
	context: Type.Object({
		variables: Type.Record(Type.String(), PlanScalarSchema),
		errorSuppression: Type.Union([Type.Literal("forbid"), Type.Literal("explicit-only"), Type.Literal("allow")]),
	}),
	states: Type.Array(PlanStateSchema, { minItems: 1 }),
	transitions: Type.Array(PlanTransitionSchema),
	limits: Type.Object({
		maxTransitions: Type.Integer({ minimum: 1 }),
		defaultMaxVisitsPerState: Type.Integer({ minimum: 1 }),
	}),
});

export type PlanScalar = Static<typeof PlanScalarSchema>;
export type PlanGuardCondition = Static<typeof PlanGuardConditionSchema>;
export type PlanGuard = Static<typeof PlanGuardSchema>;
export type PlanEffect = Static<typeof PlanEffectSchema>;
export type PlanErrorPolicy = Static<typeof PlanErrorPolicySchema>;
export type PlanState = Static<typeof PlanStateSchema>;
export type PlanTransition = Static<typeof PlanTransitionSchema>;
export type PlanParallelism = Static<typeof PlanParallelismSchema>;
export type PlanMachineDefinition = Static<typeof PlanMachineSchema>;

export type PlanRuntimeStatus = "idle" | "running" | "completed" | "failed" | "blocked";

export interface PlanTransitionRecord {
	event: string;
	sourceStateId?: string;
	evidence?: string;
	transitionIds: string[];
	activeStateIdsBefore: string[];
	activeStateIdsAfter: string[];
	timestamp: number;
}

export interface PlanRuntimeSnapshot {
	machineId: string;
	status: PlanRuntimeStatus;
	activeStateIds: string[];
	completedStateIds: string[];
	visitCounts: Record<string, number>;
	transitionCount: number;
	context: Record<string, PlanScalar>;
	history: PlanTransitionRecord[];
	blockReason?: string;
}

export interface PlanDispatchResult {
	appliedTransitionIds: string[];
	snapshot: PlanRuntimeSnapshot;
}
