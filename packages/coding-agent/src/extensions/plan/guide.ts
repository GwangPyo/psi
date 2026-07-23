import { type Static, Type } from "typebox";
import {
	type PlanErrorPolicy,
	PlanErrorPolicySchema,
	type PlanGuard,
	PlanGuardSchema,
	type PlanMachineDefinition,
	type PlanScalar,
	PlanScalarSchema,
	type PlanState,
	type PlanTransition,
	validatePlanMachine,
} from "./fsm/index.ts";

const NonEmptyString = Type.String({ minLength: 1 });
const StateIdArray = Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true });
const ErrorSuppressionSchema = Type.Union([
	Type.Literal("forbid"),
	Type.Literal("explicit-only"),
	Type.Literal("allow"),
]);
const AbstractionSchema = Type.Union([
	Type.Literal("goal"),
	Type.Literal("system"),
	Type.Literal("component"),
	Type.Literal("implementation"),
	Type.Literal("verification"),
]);

const GuideActionSchema = Type.Object({
	id: NonEmptyString,
	title: NonEmptyString,
	objective: NonEmptyString,
	doneWhen: Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true }),
	role: Type.Optional(NonEmptyString),
	abstraction: Type.Optional(AbstractionSchema),
	maxVisits: Type.Optional(Type.Integer({ minimum: 1 })),
	errorPolicy: Type.Optional(PlanErrorPolicySchema),
});

const StartGuideSchema = Type.Object({
	operation: Type.Literal("start", { description: "Initialize the plan with a goal and context" }),
	id: NonEmptyString,
	goal: NonEmptyString,
	context: Type.Optional(Type.Record(Type.String(), PlanScalarSchema)),
	errorSuppression: Type.Optional(ErrorSuppressionSchema),
	limits: Type.Optional(
		Type.Object({
			maxTransitions: Type.Optional(Type.Integer({ minimum: 1 })),
			defaultMaxVisitsPerState: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
	),
}, { description: "Start a new plan graph. MUST be the first operation." });

const AddSequenceSchema = Type.Object({
	operation: Type.Literal("add_sequence", { description: "Add a linear sequence of macro subgoals" }),
	after: Type.Optional(StateIdArray),
	steps: Type.Array(GuideActionSchema, { minItems: 1 }),
}, { description: "Add a sequence of steps (macro subgoals). Use this for producer-consumer or verification dependencies." });

const AddParallelSchema = Type.Object({
	operation: Type.Literal("add_parallel", { description: "Add parallel sibling branches" }),
	groupId: NonEmptyString,
	after: Type.Optional(StateIdArray),
	branches: Type.Array(GuideActionSchema, { minItems: 2 }),
	rationale: NonEmptyString,
}, { description: "Add parallel branches when outcomes do not consume each other's artifacts." });

const AddChoiceSchema = Type.Object({
	operation: Type.Literal("add_choice", { description: "Add an exclusive choice/branching point" }),
	choiceId: NonEmptyString,
	title: NonEmptyString,
	after: Type.Optional(StateIdArray),
	branches: Type.Array(
		Type.Object({
			event: NonEmptyString,
			guard: Type.Optional(PlanGuardSchema),
			step: GuideActionSchema,
		}),
		{ minItems: 2 },
	),
}, { description: "Add a choice node for unresolved material decisions or evidence-dependent routes." });

const ConnectSchema = Type.Object({
	operation: Type.Literal("connect", { description: "Connect existing states with a transition" }),
	from: StateIdArray,
	to: StateIdArray,
	event: NonEmptyString,
	guard: Type.Optional(PlanGuardSchema),
	priority: Type.Optional(Type.Integer()),
}, { description: "Connect states to create backward loops (e.g., for revisions/retries) or convergences." });

const UpdateStateSchema = Type.Object({
	operation: Type.Literal("update_state", { description: "Update an existing state's properties" }),
	stateId: NonEmptyString,
	title: Type.Optional(NonEmptyString),
	objective: Type.Optional(NonEmptyString),
	doneWhen: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true })),
	role: Type.Optional(NonEmptyString),
	abstraction: Type.Optional(AbstractionSchema),
	maxVisits: Type.Optional(Type.Integer({ minimum: 1 })),
	errorPolicy: Type.Optional(PlanErrorPolicySchema),
}, { description: "Modify an existing state." });

const AddFinalSchema = Type.Object({
	operation: Type.Literal("add_final", { description: "Add a final outcome state (success, failure, or blocked)" }),
	id: NonEmptyString,
	title: Type.Optional(NonEmptyString),
	from: StateIdArray,
	event: Type.Optional(NonEmptyString),
	outcome: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("blocked")])),
}, { description: "Add a final state to terminate a path." });

const FinalizeGuideSchema = Type.Object({
	operation: Type.Literal("finalize", { description: "Compile the guide into a validated PlanFSM" }),
}, { description: "Finalize the plan graph. Do this only when all open frontiers have a final, convergence, or revision path." });

export const PlanGuideCommandSchema = Type.Union([
	StartGuideSchema,
	AddSequenceSchema,
	AddParallelSchema,
	AddChoiceSchema,
	ConnectSchema,
	UpdateStateSchema,
	AddFinalSchema,
	FinalizeGuideSchema,
]);

export type PlanGuideCommand = Static<typeof PlanGuideCommandSchema>;
type GuideAction = Static<typeof GuideActionSchema>;

export interface PlanGuideDraft {
	id?: string;
	goal?: string;
	initialStateId?: string;
	context: {
		variables: Record<string, PlanScalar>;
		errorSuppression: "forbid" | "explicit-only" | "allow";
	};
	states: PlanState[];
	transitions: PlanTransition[];
	parallelGroups: Array<{ stateIds: string[]; rationale: string }>;
	limits: {
		maxTransitions?: number;
		defaultMaxVisitsPerState?: number;
	};
	nextTransitionNumber: number;
}

export interface PlanGuideStatus {
	started: boolean;
	stateCount: number;
	transitionCount: number;
	openStateIds: string[];
	parallelGroups: string[][];
}

export interface PlanGuideApplyResult {
	draft: PlanGuideDraft;
	status: PlanGuideStatus;
	machine?: PlanMachineDefinition;
	errors: string[];
}

export function createPlanGuideDraft(): PlanGuideDraft {
	return {
		context: { variables: {}, errorSuppression: "forbid" },
		states: [],
		transitions: [],
		parallelGroups: [],
		limits: {},
		nextTransitionNumber: 1,
	};
}

function visibleFailurePolicy(): PlanErrorPolicy {
	return {
		strategy: "propagate",
		mayHideFailure: false,
		suppressionAllowed: false,
		observableSignals: [],
	};
}

function actionState(action: GuideAction): PlanState {
	return {
		id: action.id,
		kind: "action",
		title: action.title,
		abstraction: action.abstraction ?? "implementation",
		role: action.role ?? "engineering",
		instruction: action.objective,
		acceptanceCriteria: action.doneWhen,
		errorPolicy: action.errorPolicy ?? visibleFailurePolicy(),
		maxVisits: action.maxVisits,
	};
}

function assertStarted(draft: PlanGuideDraft): void {
	if (!draft.id || !draft.goal) throw new Error('Start the guide with operation "start" before adding topology.');
}

function assertUniqueStateIds(draft: PlanGuideDraft, stateIds: string[]): void {
	const existing = new Set(draft.states.map((state) => state.id));
	const seen = new Set<string>();
	for (const stateId of stateIds) {
		if (existing.has(stateId)) throw new Error(`State "${stateId}" already exists.`);
		if (seen.has(stateId)) throw new Error(`State "${stateId}" is duplicated in this operation.`);
		seen.add(stateId);
	}
}

function assertKnownStateIds(draft: PlanGuideDraft, stateIds: string[]): void {
	const existing = new Set(draft.states.map((state) => state.id));
	for (const stateId of stateIds) {
		if (!existing.has(stateId)) throw new Error(`State "${stateId}" does not exist.`);
	}
}

function nextTransition(
	draft: PlanGuideDraft,
	transition: Omit<PlanTransition, "id">,
): { draft: PlanGuideDraft; transition: PlanTransition } {
	const result = structuredClone(draft);
	const id = `guide_t${result.nextTransitionNumber}`;
	result.nextTransitionNumber++;
	return { draft: result, transition: { id, ...transition } };
}

function appendTransition(draft: PlanGuideDraft, transition: Omit<PlanTransition, "id">): PlanGuideDraft {
	const created = nextTransition(draft, transition);
	created.draft.transitions.push(created.transition);
	return created.draft;
}

function eventForSources(draft: PlanGuideDraft, stateIds: string[]): string {
	const stateById = new Map(draft.states.map((state) => [state.id, state]));
	return stateIds.every((stateId) => {
		const kind = stateById.get(stateId)?.kind;
		return kind === "fork" || kind === "join" || kind === "checkpoint";
	})
		? "AUTO"
		: "SUCCESS";
}

function attachEntry(draft: PlanGuideDraft, after: string[] | undefined, entryStateId: string): PlanGuideDraft {
	if (!after) {
		if (draft.initialStateId) {
			throw new Error(
				`The guide already starts at "${draft.initialStateId}"; provide "after" to extend its frontier.`,
			);
		}
		return { ...draft, initialStateId: entryStateId };
	}
	assertKnownStateIds(draft, after);
	return appendTransition(draft, {
		from: after,
		to: [entryStateId],
		event: eventForSources(draft, after),
	});
}

function guideStatus(draft: PlanGuideDraft): PlanGuideStatus {
	const statesWithOutgoing = new Set(draft.transitions.flatMap((transition) => transition.from));
	return {
		started: Boolean(draft.id && draft.goal),
		stateCount: draft.states.length,
		transitionCount: draft.transitions.length,
		openStateIds: draft.states
			.filter((state) => state.kind !== "final" && !statesWithOutgoing.has(state.id))
			.map((state) => state.id),
		parallelGroups: draft.parallelGroups.map((group) => [...group.stateIds]),
	};
}

function finalizeGuide(draft: PlanGuideDraft): PlanGuideApplyResult {
	assertStarted(draft);
	const status = guideStatus(draft);
	if (!draft.initialStateId) {
		return { draft, status, errors: ["The guide has no initial topology."] };
	}
	if (status.openStateIds.length > 0) {
		return {
			draft,
			status,
			errors: [
				`Open frontier states need convergence, revision, or final paths: ${status.openStateIds.join(", ")}.`,
			],
		};
	}
	const parallelism =
		draft.parallelGroups.length > 0
			? {
					strategy: "parallel" as const,
					rationale: draft.parallelGroups.map((group) => group.rationale).join(" "),
					independentStateGroups: draft.parallelGroups.map((group) => [...group.stateIds]),
				}
			: {
					strategy: "sequential" as const,
					rationale:
						"All submitted work is connected by explicit sequence, choice, convergence, or revision dependencies.",
					independentStateGroups: [],
				};
	const machine: PlanMachineDefinition = {
		version: 1,
		id: draft.id!,
		goal: draft.goal!,
		initialStateId: draft.initialStateId,
		parallelism,
		context: structuredClone(draft.context),
		states: structuredClone(draft.states),
		transitions: structuredClone(draft.transitions),
		limits: {
			maxTransitions: draft.limits.maxTransitions ?? Math.max(30, draft.states.length * 4),
			defaultMaxVisitsPerState: draft.limits.defaultMaxVisitsPerState ?? 3,
		},
	};
	const validation = validatePlanMachine(machine);
	return {
		draft,
		status,
		machine: validation.machine,
		errors: validation.errors,
	};
}

export function applyPlanGuideCommand(current: PlanGuideDraft, command: PlanGuideCommand): PlanGuideApplyResult {
	let draft = structuredClone(current);

	switch (command.operation) {
		case "start":
			if (draft.id || draft.goal || draft.states.length > 0) {
				throw new Error("The guide has already started. Refine the existing graph or restart plan mode.");
			}
			draft.id = command.id;
			draft.goal = command.goal;
			draft.context = {
				variables: command.context ?? {},
				errorSuppression: command.errorSuppression ?? "forbid",
			};
			draft.limits = command.limits ?? {};
			break;

		case "add_sequence": {
			assertStarted(draft);
			const states = command.steps.map(actionState);
			assertUniqueStateIds(
				draft,
				states.map((state) => state.id),
			);
			draft.states.push(...states);
			draft = attachEntry(draft, command.after, states[0]!.id);
			for (let index = 1; index < states.length; index++) {
				draft = appendTransition(draft, {
					from: [states[index - 1]!.id],
					to: [states[index]!.id],
					event: "SUCCESS",
				});
			}
			break;
		}

		case "add_parallel": {
			assertStarted(draft);
			const forkId = `${command.groupId}__fork`;
			const joinId = `${command.groupId}__join`;
			const branches = command.branches.map(actionState);
			const checkpoints = branches.map((state) => ({
				id: `${command.groupId}__${state.id}__done`,
				kind: "checkpoint" as const,
				title: `${state.title} complete`,
				abstraction: "component" as const,
				role: "scheduler",
				acceptanceCriteria: [],
			}));
			assertUniqueStateIds(draft, [
				forkId,
				joinId,
				...branches.map((state) => state.id),
				...checkpoints.map((state) => state.id),
			]);
			draft.states.push(
				{
					id: forkId,
					kind: "fork",
					title: `${command.groupId} fork`,
					abstraction: "component",
					role: "scheduler",
					acceptanceCriteria: [],
				},
				...branches,
				...checkpoints,
				{
					id: joinId,
					kind: "join",
					title: `${command.groupId} join`,
					abstraction: "component",
					role: "scheduler",
					acceptanceCriteria: [],
				},
			);
			draft = attachEntry(draft, command.after, forkId);
			draft = appendTransition(draft, {
				from: [forkId],
				to: branches.map((state) => state.id),
				event: "AUTO",
			});
			draft = appendTransition(draft, {
				from: [branches[0]!.id],
				to: [checkpoints[0]!.id],
				event: "SUCCESS",
			});
			for (let index = 1; index < branches.length; index++) {
				draft = appendTransition(draft, {
					from: [branches[index]!.id],
					to: [checkpoints[index]!.id],
					event: "SUCCESS",
				});
			}
			draft = appendTransition(draft, {
				from: checkpoints.map((state) => state.id),
				to: [joinId],
				event: "AUTO",
			});
			draft.parallelGroups.push({
				stateIds: branches.map((state) => state.id),
				rationale: command.rationale,
			});
			break;
		}

		case "add_choice": {
			assertStarted(draft);
			const branchStates = command.branches.map((branch) => actionState(branch.step));
			assertUniqueStateIds(draft, [command.choiceId, ...branchStates.map((state) => state.id)]);
			draft.states.push(
				{
					id: command.choiceId,
					kind: "choice",
					title: command.title,
					abstraction: "component",
					role: "decision",
					acceptanceCriteria: [],
				},
				...branchStates,
			);
			draft = attachEntry(draft, command.after, command.choiceId);
			for (let index = 0; index < command.branches.length; index++) {
				const branch = command.branches[index]!;
				draft = appendTransition(draft, {
					from: [command.choiceId],
					to: [branchStates[index]!.id],
					event: branch.event,
					guard: branch.guard as PlanGuard | undefined,
					priority: command.branches.length - index,
				});
			}
			break;
		}

		case "connect":
			assertStarted(draft);
			assertKnownStateIds(draft, [...command.from, ...command.to]);
			draft = appendTransition(draft, {
				from: command.from,
				to: command.to,
				event: command.event,
				guard: command.guard as PlanGuard | undefined,
				priority: command.priority,
			});
			break;

		case "update_state": {
			assertStarted(draft);
			const index = draft.states.findIndex((state) => state.id === command.stateId);
			if (index === -1) throw new Error(`State "${command.stateId}" does not exist.`);
			const state = draft.states[index]!;
			if (state.kind !== "action")
				throw new Error(`Only action states can be updated; "${command.stateId}" is ${state.kind}.`);
			draft.states[index] = {
				...state,
				title: command.title ?? state.title,
				instruction: command.objective ?? state.instruction,
				acceptanceCriteria: command.doneWhen ?? state.acceptanceCriteria,
				role: command.role ?? state.role,
				abstraction: command.abstraction ?? state.abstraction,
				maxVisits: command.maxVisits ?? state.maxVisits,
				errorPolicy: command.errorPolicy ?? state.errorPolicy,
			};
			break;
		}

		case "add_final": {
			assertStarted(draft);
			assertKnownStateIds(draft, command.from);
			assertUniqueStateIds(draft, [command.id]);
			draft.states.push({
				id: command.id,
				kind: "final",
				title: command.title ?? command.id,
				abstraction: "verification",
				role: "scheduler",
				acceptanceCriteria: [],
				finalOutcome: command.outcome ?? "success",
			});
			draft = appendTransition(draft, {
				from: command.from,
				to: [command.id],
				event: command.event ?? eventForSources(draft, command.from),
			});
			break;
		}

		case "finalize":
			return finalizeGuide(draft);
	}

	return { draft, status: guideStatus(draft), errors: [] };
}

export function formatPlanGuideStatus(draft: PlanGuideDraft): string {
	const status = guideStatus(draft);
	if (!status.started) return "No plan guide has been started.";
	return [
		`Plan guide: ${status.stateCount} states, ${status.transitionCount} transitions.`,
		`Open frontier: ${status.openStateIds.length > 0 ? status.openStateIds.join(", ") : "none"}.`,
		`Parallel groups: ${status.parallelGroups.length > 0 ? status.parallelGroups.map((group) => `[${group.join(", ")}]`).join(", ") : "none"}.`,
	].join(" ");
}
