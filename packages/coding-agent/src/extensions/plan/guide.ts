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
const IndependentStateIdArray = Type.Array(NonEmptyString, { minItems: 2, uniqueItems: true });
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
const QuestionReviewDimensionSchema = Type.Union([
	Type.Literal("what"),
	Type.Literal("how"),
	Type.Literal("why"),
	Type.Literal("when"),
]);
const ReviewDimensionSchema = Type.Union([QuestionReviewDimensionSchema, Type.Literal("dependencies")]);
const REVIEW_DIMENSIONS = ["what", "how", "why", "when", "dependencies"] as const;
export type PlanGuideReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

const GuideActionSchema = Type.Object({
	id: NonEmptyString,
	title: NonEmptyString,
	objective: NonEmptyString,
	doneWhen: Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true }),
	role: Type.Optional(NonEmptyString),
	abstraction: Type.Optional(AbstractionSchema),
	parentId: Type.Optional(NonEmptyString),
	maxVisits: Type.Optional(Type.Integer({ minimum: 1 })),
	errorPolicy: Type.Optional(PlanErrorPolicySchema),
});

const StartGuideSchema = Type.Object(
	{
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
	},
	{ description: "Start a new plan graph. MUST be the first operation." },
);

const AddSequenceSchema = Type.Object(
	{
		operation: Type.Literal("add_sequence", { description: "Add a linear sequence of macro subgoals" }),
		after: Type.Optional(StateIdArray),
		steps: Type.Array(GuideActionSchema, { minItems: 1 }),
	},
	{
		description:
			"Add a sequence of steps (macro subgoals). Use this for producer-consumer or verification dependencies.",
	},
);

const AddParallelSchema = Type.Object(
	{
		operation: Type.Literal("add_parallel", { description: "Add parallel sibling branches" }),
		groupId: NonEmptyString,
		after: Type.Optional(StateIdArray),
		branches: Type.Array(GuideActionSchema, { minItems: 2 }),
		rationale: NonEmptyString,
	},
	{ description: "Add parallel branches when outcomes do not consume each other's artifacts." },
);

const AddChoiceSchema = Type.Object(
	{
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
	},
	{ description: "Add a choice node for unresolved material decisions or evidence-dependent routes." },
);

const ConnectSchema = Type.Object(
	{
		operation: Type.Literal("connect", { description: "Connect existing states with a transition" }),
		from: StateIdArray,
		to: StateIdArray,
		event: NonEmptyString,
		guard: Type.Optional(PlanGuardSchema),
		priority: Type.Optional(Type.Integer()),
	},
	{ description: "Connect states to create backward loops (e.g., for revisions/retries) or convergences." },
);

const UpdateStateSchema = Type.Object(
	{
		operation: Type.Literal("update_state", { description: "Update an existing state's properties" }),
		stateId: NonEmptyString,
		title: Type.Optional(NonEmptyString),
		objective: Type.Optional(NonEmptyString),
		doneWhen: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true })),
		role: Type.Optional(NonEmptyString),
		abstraction: Type.Optional(AbstractionSchema),
		parentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
		maxVisits: Type.Optional(Type.Integer({ minimum: 1 })),
		errorPolicy: Type.Optional(PlanErrorPolicySchema),
	},
	{ description: "Modify an existing state." },
);

const AddFinalSchema = Type.Object(
	{
		operation: Type.Literal("add_final", { description: "Add a final outcome state (success, failure, or blocked)" }),
		id: NonEmptyString,
		title: Type.Optional(NonEmptyString),
		from: StateIdArray,
		event: Type.Optional(NonEmptyString),
		outcome: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("blocked")])),
	},
	{ description: "Add a final state to terminate a path." },
);

const RemoveTransitionSchema = Type.Object(
	{
		operation: Type.Literal("remove_transition", {
			description: "Remove one transition while revising retained topology",
		}),
		transitionId: NonEmptyString,
	},
	{ description: "Remove an affected transition before reconnecting or rebuilding only that part of the graph." },
);

const RemoveStateSchema = Type.Object(
	{
		operation: Type.Literal("remove_state", {
			description: "Remove one unreferenced state while revising retained topology",
		}),
		stateId: NonEmptyString,
	},
	{ description: "Remove a state after removing all transitions and parent references that use it." },
);

const SetInitialStateSchema = Type.Object(
	{
		operation: Type.Literal("set_initial", { description: "Set or clear the retained FSM initial state" }),
		stateId: Type.Union([NonEmptyString, Type.Null()]),
	},
	{
		description:
			"Use during topology revision to move the initial state or clear it before rebuilding the entry frontier.",
	},
);

const ReviewGuideSchema = Type.Object(
	{
		operation: Type.Literal("review", {
			description: "Question the current plan from the next required review dimension",
		}),
		dimension: QuestionReviewDimensionSchema,
		assessment: NonEmptyString,
	},
	{
		description:
			"Review the retained FSM in strict what, how, why, when order. Each review must be followed by a concrete topology or state revision.",
	},
);

const DependencyAuditSchema = Type.Object(
	{
		operation: Type.Literal("review_dependencies", {
			description: "Classify sibling task dependencies against the retained FSM",
		}),
		assessment: NonEmptyString,
		independentGroups: Type.Array(IndependentStateIdArray),
		sequentialDependencies: Type.Array(
			Type.Object({
				before: NonEmptyString,
				after: NonEmptyString,
				reason: Type.String({ minLength: 20 }),
			}),
			{
				description:
					"Concrete producer-consumer edges. They may cross parent and abstraction boundaries; transitive chains justify the resulting order.",
			},
		),
	},
	{
		description:
			"Final FSM-level dependency audit. Independent sibling tasks need fork/join topology; real sequential dependencies may cross hierarchy boundaries.",
	},
);

const ReviseGuideSchema = Type.Object(
	{
		operation: Type.Literal("revise", { description: "Record the completed revision for the pending review" }),
		dimension: Type.Optional(ReviewDimensionSchema),
		summary: NonEmptyString,
		changedStateIds: Type.Optional(Type.Array(NonEmptyString, { uniqueItems: true })),
		changedTransitionIds: Type.Optional(Type.Array(NonEmptyString, { uniqueItems: true })),
	},
	{
		description:
			"Complete the retained pending review after at least one state or topology operation changed the FSM. Do not rediscover or guess the review dimension.",
	},
);

const FinalizeGuideSchema = Type.Object(
	{
		operation: Type.Literal("finalize", { description: "Compile the guide into a validated PlanFSM" }),
	},
	{
		description:
			"Finalize only after all open frontiers are closed, what/how/why/when revisions are complete, and the FSM dependency audit has forced independent tasks into parallel topology.",
	},
);

export const PlanGuideCommandSchema = Type.Union([
	StartGuideSchema,
	AddSequenceSchema,
	AddParallelSchema,
	AddChoiceSchema,
	ConnectSchema,
	UpdateStateSchema,
	AddFinalSchema,
	RemoveTransitionSchema,
	RemoveStateSchema,
	SetInitialStateSchema,
	ReviewGuideSchema,
	DependencyAuditSchema,
	ReviseGuideSchema,
	FinalizeGuideSchema,
]);

export type PlanGuideCommand = Static<typeof PlanGuideCommandSchema>;
type GuideAction = Static<typeof GuideActionSchema>;

function normalizeErrorPolicy(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;

	const policy = input as Record<string, unknown>;
	if (typeof policy.strategy !== "string") return input;

	const strategy = policy.strategy.trim().toLowerCase();
	const normalizedStrategy =
		strategy === "fail" || strategy === "failure" || strategy === "throw" ? "propagate" : strategy;
	if (
		normalizedStrategy !== "propagate" &&
		normalizedStrategy !== "translate" &&
		normalizedStrategy !== "retry" &&
		normalizedStrategy !== "fallback" &&
		normalizedStrategy !== "suppress"
	) {
		return input;
	}
	if (normalizedStrategy === policy.strategy) return input;
	return { ...policy, strategy: normalizedStrategy };
}

function normalizeGuideAction(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;

	const action = input as Record<string, unknown>;
	if (action.errorPolicy === undefined) return input;
	const errorPolicy = normalizeErrorPolicy(action.errorPolicy);
	return errorPolicy === action.errorPolicy ? input : { ...action, errorPolicy };
}

export function preparePlanGuideArguments(
	input: unknown,
	pendingReviewDimension?: PlanGuideReviewDimension,
): PlanGuideCommand {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return input as PlanGuideCommand;
	}

	const args = input as Record<string, unknown>;
	let normalized: Record<string, unknown> = args;
	if (args.operation === "modify_state") {
		normalized = { ...args, operation: "update_state" };
		if (typeof normalized.stateId !== "string" && typeof normalized.id === "string") {
			normalized.stateId = normalized.id;
		}
		if (typeof normalized.objective !== "string" && typeof normalized.instruction === "string") {
			normalized.objective = normalized.instruction;
		}
		if (!Array.isArray(normalized.doneWhen) && Array.isArray(normalized.acceptanceCriteria)) {
			normalized.doneWhen = normalized.acceptanceCriteria;
		}
		delete normalized.id;
		delete normalized.instruction;
		delete normalized.acceptanceCriteria;
	}

	if (normalized.operation === "add_sequence" && Array.isArray(normalized.steps)) {
		normalized = { ...normalized, steps: normalized.steps.map(normalizeGuideAction) };
	} else if (normalized.operation === "add_parallel" && Array.isArray(normalized.branches)) {
		normalized = { ...normalized, branches: normalized.branches.map(normalizeGuideAction) };
	} else if (normalized.operation === "add_choice" && Array.isArray(normalized.branches)) {
		normalized = {
			...normalized,
			branches: normalized.branches.map((inputBranch) => {
				if (!inputBranch || typeof inputBranch !== "object" || Array.isArray(inputBranch)) return inputBranch;
				const branch = inputBranch as Record<string, unknown>;
				const step = normalizeGuideAction(branch.step);
				return step === branch.step ? inputBranch : { ...branch, step };
			}),
		};
	} else if (normalized.operation === "update_state" && normalized.errorPolicy !== undefined) {
		const errorPolicy = normalizeErrorPolicy(normalized.errorPolicy);
		if (errorPolicy !== normalized.errorPolicy) normalized = { ...normalized, errorPolicy };
	} else if (normalized.operation === "revise" && pendingReviewDimension) {
		normalized = { ...normalized, dimension: pendingReviewDimension };
	}

	return normalized as PlanGuideCommand;
}

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
	reviews: Array<{
		dimension: PlanGuideReviewDimension;
		assessment: string;
		revisionSummary: string;
	}>;
	dependencyAudit?: {
		independentGroups: string[][];
		sequentialDependencies: Array<{ before: string; after: string; reason: string }>;
	};
	pendingReview?: {
		dimension: PlanGuideReviewDimension;
		assessment: string;
		changed: boolean;
	};
	nextTransitionNumber: number;
}

export interface PlanGuideStatus {
	started: boolean;
	stateCount: number;
	transitionCount: number;
	openStateIds: string[];
	parallelGroups: string[][];
	completedReviewDimensions: PlanGuideReviewDimension[];
	pendingReviewDimension?: PlanGuideReviewDimension;
	nextReviewDimension?: PlanGuideReviewDimension;
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
		reviews: [],
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
		parentId: action.parentId,
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
	const reviews = draft.reviews ?? [];
	return {
		started: Boolean(draft.id && draft.goal),
		stateCount: draft.states.length,
		transitionCount: draft.transitions.length,
		openStateIds: draft.states
			.filter((state) => state.kind !== "final" && !statesWithOutgoing.has(state.id))
			.map((state) => state.id),
		parallelGroups: draft.parallelGroups.map((group) => [...group.stateIds]),
		completedReviewDimensions: reviews.map((review) => review.dimension),
		pendingReviewDimension: draft.pendingReview?.dimension,
		nextReviewDimension: draft.pendingReview ? undefined : REVIEW_DIMENSIONS[reviews.length],
	};
}

function hasTransitionPath(draft: PlanGuideDraft, fromStateId: string, toStateId: string): boolean {
	const visited = new Set([fromStateId]);
	const queue = [fromStateId];
	while (queue.length > 0) {
		const stateId = queue.shift()!;
		for (const transition of draft.transitions) {
			if (!transition.from.includes(stateId)) continue;
			for (const targetId of transition.to) {
				if (targetId === toStateId) return true;
				if (visited.has(targetId)) continue;
				visited.add(targetId);
				queue.push(targetId);
			}
		}
	}
	return false;
}

function pairKey(left: string, right: string): string {
	return [left, right].sort().join("\u0000");
}

function validateDependencyAudit(draft: PlanGuideDraft): string[] {
	const audit = draft.dependencyAudit;
	if (!audit) return ["The final FSM dependency audit is missing."];

	const errors: string[] = [];
	const stateById = new Map(draft.states.map((state) => [state.id, state]));
	const taskGroups = new Map<string, string[]>();
	for (const state of draft.states) {
		if (
			state.kind !== "action" ||
			(state.abstraction !== "component" &&
				state.abstraction !== "implementation" &&
				state.abstraction !== "verification")
		) {
			continue;
		}
		const groupId = state.parentId ?? "__root__";
		const group = taskGroups.get(groupId) ?? [];
		group.push(state.id);
		taskGroups.set(groupId, group);
	}

	const independentPairs = new Set<string>();
	for (const [groupIndex, group] of audit.independentGroups.entries()) {
		const parentIds = new Set<string>();
		for (const stateId of group) {
			const state = stateById.get(stateId);
			if (!state) {
				errors.push(`Dependency audit independent group ${groupIndex + 1} references missing state "${stateId}".`);
			} else if (
				state.kind !== "action" ||
				(state.abstraction !== "component" &&
					state.abstraction !== "implementation" &&
					state.abstraction !== "verification")
			) {
				errors.push(
					`Dependency audit independent state "${stateId}" must be a component, implementation, or verification action.`,
				);
			} else {
				parentIds.add(state.parentId ?? "__root__");
			}
		}
		if (parentIds.size > 1) {
			errors.push(`Dependency audit independent group ${groupIndex + 1} must contain sibling tasks.`);
		}
		for (let leftIndex = 0; leftIndex < group.length; leftIndex++) {
			for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex++) {
				const left = group[leftIndex]!;
				const right = group[rightIndex]!;
				independentPairs.add(pairKey(left, right));
				if (hasTransitionPath(draft, left, right) || hasTransitionPath(draft, right, left)) {
					errors.push(`Independent tasks "${left}" and "${right}" must not be serialized by an FSM path.`);
				}
			}
		}
		const hasParallelTopology = draft.parallelGroups.some((parallelGroup) =>
			group.every((stateId) => parallelGroup.stateIds.includes(stateId)),
		);
		if (!hasParallelTopology) {
			errors.push(
				`Independent group ${groupIndex + 1} (${group.join(", ")}) must be implemented by add_parallel fork/join topology.`,
			);
		}
	}

	const sequentialPairs = new Set<string>();
	const sequentialSuccessors = new Map<string, string[]>();
	for (const dependency of audit.sequentialDependencies) {
		const key = pairKey(dependency.before, dependency.after);
		if (sequentialPairs.has(key)) {
			errors.push(
				`Dependency audit classifies "${dependency.before}" and "${dependency.after}" more than once as sequential.`,
			);
			continue;
		}
		sequentialPairs.add(key);
		const successors = sequentialSuccessors.get(dependency.before) ?? [];
		successors.push(dependency.after);
		sequentialSuccessors.set(dependency.before, successors);
		const beforeState = stateById.get(dependency.before);
		const afterState = stateById.get(dependency.after);
		if (!beforeState) {
			errors.push(`Dependency audit references missing predecessor "${dependency.before}".`);
		}
		if (!afterState) {
			errors.push(`Dependency audit references missing successor "${dependency.after}".`);
		}
		if (!hasTransitionPath(draft, dependency.before, dependency.after)) {
			errors.push(`Sequential dependency "${dependency.before}" -> "${dependency.after}" has no matching FSM path.`);
		}
	}

	const hasSequentialDependencyPath = (fromStateId: string, toStateId: string): boolean => {
		const visited = new Set([fromStateId]);
		const queue = [fromStateId];
		while (queue.length > 0) {
			const stateId = queue.shift()!;
			for (const successorId of sequentialSuccessors.get(stateId) ?? []) {
				if (successorId === toStateId) return true;
				if (visited.has(successorId)) continue;
				visited.add(successorId);
				queue.push(successorId);
			}
		}
		return false;
	};

	for (const [groupId, stateIds] of taskGroups) {
		for (let leftIndex = 0; leftIndex < stateIds.length; leftIndex++) {
			for (let rightIndex = leftIndex + 1; rightIndex < stateIds.length; rightIndex++) {
				const left = stateIds[leftIndex]!;
				const right = stateIds[rightIndex]!;
				const key = pairKey(left, right);
				const isIndependent = independentPairs.has(key);
				const isSequential = hasSequentialDependencyPath(left, right) || hasSequentialDependencyPath(right, left);
				if (!isIndependent && !isSequential) {
					errors.push(
						`Sibling tasks "${left}" and "${right}" under "${groupId}" are unclassified; declare them independent or justify a sequential dependency.`,
					);
				} else if (isIndependent && isSequential) {
					errors.push(`Sibling tasks "${left}" and "${right}" cannot be both independent and sequential.`);
				}
			}
		}
	}
	return errors;
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
	if (status.pendingReviewDimension) {
		return {
			draft,
			status,
			errors: [`Complete the pending "${status.pendingReviewDimension}" revision before finalizing.`],
		};
	}
	if (status.completedReviewDimensions.length < REVIEW_DIMENSIONS.length) {
		return {
			draft,
			status,
			errors: [`Review and revise the plan from the "${status.nextReviewDimension}" dimension before finalizing.`],
		};
	}
	const dependencyErrors = validateDependencyAudit(draft);
	if (dependencyErrors.length > 0) {
		return { draft, status, errors: dependencyErrors };
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
	draft.reviews ??= [];
	let changed = false;

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
			changed = true;
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
			changed = true;
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
			changed = true;
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
			changed = true;
			break;

		case "update_state": {
			assertStarted(draft);
			const index = draft.states.findIndex((state) => state.id === command.stateId);
			if (index === -1) throw new Error(`State "${command.stateId}" does not exist.`);
			const state = draft.states[index]!;
			if (state.kind !== "action")
				throw new Error(`Only action states can be updated; "${command.stateId}" is ${state.kind}.`);
			const updatedState = {
				...state,
				title: command.title ?? state.title,
				instruction: command.objective ?? state.instruction,
				acceptanceCriteria: command.doneWhen ?? state.acceptanceCriteria,
				role: command.role ?? state.role,
				abstraction: command.abstraction ?? state.abstraction,
				parentId: command.parentId === null ? undefined : (command.parentId ?? state.parentId),
				maxVisits: command.maxVisits ?? state.maxVisits,
				errorPolicy: command.errorPolicy ?? state.errorPolicy,
			};
			if (JSON.stringify(updatedState) === JSON.stringify(state)) {
				throw new Error(`Update for state "${command.stateId}" did not change any PlanFSM field.`);
			}
			draft.states[index] = updatedState;
			changed = true;
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
			changed = true;
			break;
		}

		case "remove_transition": {
			assertStarted(draft);
			const transitionIndex = draft.transitions.findIndex((transition) => transition.id === command.transitionId);
			if (transitionIndex === -1) throw new Error(`Transition "${command.transitionId}" does not exist.`);
			draft.transitions.splice(transitionIndex, 1);
			changed = true;
			break;
		}

		case "remove_state": {
			assertStarted(draft);
			const stateIndex = draft.states.findIndex((state) => state.id === command.stateId);
			if (stateIndex === -1) throw new Error(`State "${command.stateId}" does not exist.`);
			if (draft.initialStateId === command.stateId) {
				throw new Error(`State "${command.stateId}" is the initial state and cannot be removed.`);
			}
			const referencingTransition = draft.transitions.find(
				(transition) => transition.from.includes(command.stateId) || transition.to.includes(command.stateId),
			);
			if (referencingTransition) {
				throw new Error(
					`Remove transition "${referencingTransition.id}" before removing state "${command.stateId}".`,
				);
			}
			const child = draft.states.find((state) => state.parentId === command.stateId);
			if (child) {
				throw new Error(`Update child state "${child.id}" before removing its parent "${command.stateId}".`);
			}
			draft.states.splice(stateIndex, 1);
			draft.parallelGroups = draft.parallelGroups
				.map((group) => ({
					...group,
					stateIds: group.stateIds.filter((stateId) => stateId !== command.stateId),
				}))
				.filter((group) => group.stateIds.length >= 2);
			changed = true;
			break;
		}

		case "set_initial":
			assertStarted(draft);
			if (command.stateId !== null) assertKnownStateIds(draft, [command.stateId]);
			if (draft.initialStateId === command.stateId || (!draft.initialStateId && command.stateId === null)) {
				throw new Error("set_initial did not change the retained initial state.");
			}
			draft.initialStateId = command.stateId ?? undefined;
			changed = true;
			break;

		case "review": {
			assertStarted(draft);
			if (draft.states.length === 0) throw new Error("Draft topology before starting the review cycle.");
			if (draft.pendingReview) {
				throw new Error(
					`Revise the pending "${draft.pendingReview.dimension}" review before starting another review.`,
				);
			}
			const expectedDimension = REVIEW_DIMENSIONS[draft.reviews.length];
			if (!expectedDimension) {
				throw new Error("The what, how, why, when, dependencies review cycle is already complete.");
			}
			if (expectedDimension === "dependencies") {
				throw new Error('Run operation "review_dependencies" for the final FSM dependency audit.');
			}
			if (command.dimension !== expectedDimension) {
				throw new Error(`Review "${expectedDimension}" next; received "${command.dimension}".`);
			}
			draft.pendingReview = {
				dimension: command.dimension,
				assessment: command.assessment,
				changed: false,
			};
			break;
		}

		case "review_dependencies": {
			assertStarted(draft);
			if (draft.pendingReview) {
				throw new Error(
					`Revise the pending "${draft.pendingReview.dimension}" review before the dependency audit.`,
				);
			}
			const expectedDimension = REVIEW_DIMENSIONS[draft.reviews.length];
			if (expectedDimension !== "dependencies") {
				throw new Error(`Review and revise "${expectedDimension}" before the final dependency audit.`);
			}
			for (const group of command.independentGroups) assertKnownStateIds(draft, group);
			for (const dependency of command.sequentialDependencies) {
				assertKnownStateIds(draft, [dependency.before, dependency.after]);
				if (dependency.before === dependency.after) {
					throw new Error(`Task "${dependency.before}" cannot depend sequentially on itself.`);
				}
			}
			draft.dependencyAudit = {
				independentGroups: command.independentGroups.map((group) => [...group]),
				sequentialDependencies: command.sequentialDependencies.map((dependency) => ({ ...dependency })),
			};
			draft.pendingReview = {
				dimension: "dependencies",
				assessment: command.assessment,
				changed: false,
			};
			break;
		}

		case "revise": {
			assertStarted(draft);
			const pendingReview = draft.pendingReview;
			if (!pendingReview) throw new Error('Call operation "review" before recording a revision.');
			if (!pendingReview.changed) {
				throw new Error(
					`The "${pendingReview.dimension}" review requires at least one state or topology mutation before revise.`,
				);
			}
			const stateIds = command.changedStateIds ?? [];
			const transitionIds = command.changedTransitionIds ?? [];
			assertKnownStateIds(draft, stateIds);
			const knownTransitionIds = new Set(draft.transitions.map((transition) => transition.id));
			for (const transitionId of transitionIds) {
				if (!knownTransitionIds.has(transitionId)) {
					throw new Error(`Transition "${transitionId}" does not exist.`);
				}
			}
			if (pendingReview.dimension === "dependencies") {
				const dependencyErrors = validateDependencyAudit(draft);
				if (dependencyErrors.length > 0) {
					throw new Error(`Dependency revision is incomplete:\n- ${dependencyErrors.join("\n- ")}`);
				}
			}
			draft.reviews.push({
				dimension: pendingReview.dimension,
				assessment: pendingReview.assessment,
				revisionSummary: command.summary,
			});
			draft.pendingReview = undefined;
			break;
		}

		case "finalize":
			return finalizeGuide(draft);
	}

	if (changed && draft.pendingReview) {
		draft.pendingReview.changed = true;
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
		`Review cycle: ${
			status.pendingReviewDimension
				? `${status.pendingReviewDimension} reviewed; revise the FSM next`
				: status.nextReviewDimension
					? `${status.completedReviewDimensions.length}/${REVIEW_DIMENSIONS.length} complete; review ${status.nextReviewDimension} next`
					: "what/how/why/when/dependencies complete"
		}.`,
	].join(" ");
}

function formatNextGuideAction(draft: PlanGuideDraft): string {
	const status = guideStatus(draft);
	if (!status.started) {
		return 'Call `{"operation":"start","id":"...","goal":"..."}` once.';
	}

	if (draft.pendingReview) {
		if (!draft.pendingReview.changed) {
			return `The retained "${draft.pendingReview.dimension}" review is pending. Make one concrete state or topology mutation now; do not call review, revise, or finalize yet.`;
		}
		return `Complete the retained "${draft.pendingReview.dimension}" review now with \`{"operation":"revise","summary":"...","changedStateIds":[...]}\`. The server supplies the dimension; do not inspect code or guess it.`;
	}

	if (draft.states.length === 0) {
		return "Build the macro topology next with add_sequence, add_parallel, or add_choice.";
	}

	if (status.openStateIds.length > 0) {
		return `Close or expand the retained frontier [${status.openStateIds.join(", ")}] with one topology operation. Prefer add_parallel for independent siblings and add_final only for a completed outcome.`;
	}

	if (status.nextReviewDimension === "dependencies") {
		return 'Run `{"operation":"review_dependencies",...}` next using the retained state IDs and topology below.';
	}
	if (status.nextReviewDimension) {
		return `Run \`{"operation":"review","dimension":"${status.nextReviewDimension}","assessment":"..."}\` next.`;
	}
	return 'Call `{"operation":"finalize"}` now.';
}

export function formatPlanGuideGrounding(draft: PlanGuideDraft): string {
	const stateLines =
		draft.states.length === 0
			? ["- none"]
			: draft.states.map((state) => {
					const parent = state.parentId ? ` parent=${state.parentId}` : "";
					const abstraction = state.abstraction ? `/${state.abstraction}` : "";
					return `- ${state.id} [${state.kind}${abstraction}${parent}]: ${state.title}`;
				});
	const transitionLines =
		draft.transitions.length === 0
			? ["- none"]
			: draft.transitions.map(
					(transition) =>
						`- ${transition.id}: [${transition.from.join(", ")}] -> [${transition.to.join(", ")}] on ${transition.event}`,
				);
	const audit = draft.dependencyAudit;
	const auditLines = audit
		? [
				`- independent: ${
					audit.independentGroups.length > 0
						? audit.independentGroups.map((group) => `[${group.join(", ")}]`).join(", ")
						: "none"
				}`,
				`- sequential: ${
					audit.sequentialDependencies.length > 0
						? audit.sequentialDependencies
								.map((dependency) => `${dependency.before} -> ${dependency.after}`)
								.join(", ")
						: "none"
				}`,
			]
		: ["- not submitted"];

	return [
		formatPlanGuideStatus(draft),
		"",
		"Authoritative retained FSM:",
		"States:",
		...stateLines,
		"Transitions:",
		...transitionLines,
		"Dependency audit:",
		...auditLines,
		"",
		`Next required action: ${formatNextGuideAction(draft)}`,
		"Use the guide_plan schema and this retained snapshot as the complete planning contract. Never search project files for guide_plan examples, its schema, or validator implementation.",
	].join("\n");
}
