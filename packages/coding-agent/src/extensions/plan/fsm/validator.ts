import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { type PlanMachineDefinition, PlanMachineSchema } from "./schema.ts";

export interface PlanMachineValidationResult {
	ok: boolean;
	errors: string[];
	warnings: string[];
	machine?: PlanMachineDefinition;
}

const checkPlanMachine = Compile(PlanMachineSchema);

function formatSchemaError(error: TLocalizedValidationError): string {
	const path = error.instancePath.replace(/^\//, "").replaceAll("/", ".") || "root";
	return `${path}: ${error.message}`;
}

function findReachableStateIds(machine: PlanMachineDefinition): Set<string> {
	const reachable = new Set([machine.initialStateId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const transition of machine.transitions) {
			if (!transition.from.every((stateId) => reachable.has(stateId))) continue;
			for (const stateId of transition.to) {
				if (!reachable.has(stateId)) {
					reachable.add(stateId);
					changed = true;
				}
			}
		}
	}
	return reachable;
}

function validateParentHierarchy(machine: PlanMachineDefinition, errors: string[]): void {
	const stateById = new Map(machine.states.map((state) => [state.id, state]));
	for (const state of machine.states) {
		if (!state.parentId) continue;
		if (!stateById.has(state.parentId)) {
			errors.push(`State "${state.id}" references missing parent "${state.parentId}".`);
			continue;
		}

		const visited = new Set([state.id]);
		let parentId: string | undefined = state.parentId;
		while (parentId) {
			if (visited.has(parentId)) {
				errors.push(`State hierarchy contains a cycle involving "${state.id}" and "${parentId}".`);
				break;
			}
			visited.add(parentId);
			parentId = stateById.get(parentId)?.parentId;
		}
	}
}

export function validatePlanMachine(value: unknown): PlanMachineValidationResult {
	if (!checkPlanMachine.Check(value)) {
		return {
			ok: false,
			errors: Array.from(checkPlanMachine.Errors(value), formatSchemaError),
			warnings: [],
		};
	}

	const machine = value as PlanMachineDefinition;
	const errors: string[] = [];
	const warnings: string[] = [];
	const stateIds = new Set<string>();
	const transitionIds = new Set<string>();

	for (const state of machine.states) {
		if (stateIds.has(state.id)) errors.push(`Duplicate state id "${state.id}".`);
		stateIds.add(state.id);
	}

	if (!stateIds.has(machine.initialStateId)) {
		errors.push(`Initial state "${machine.initialStateId}" does not exist.`);
	}

	if (machine.parallelism.strategy === "parallel" && machine.parallelism.independentStateGroups.length === 0) {
		errors.push("Parallel strategy must declare at least one independent state group.");
	}
	if (machine.parallelism.strategy === "sequential" && machine.parallelism.independentStateGroups.length > 0) {
		errors.push("Sequential strategy must not declare independent state groups.");
	}
	for (const [groupIndex, group] of machine.parallelism.independentStateGroups.entries()) {
		for (const stateId of group) {
			const state = machine.states.find((candidate) => candidate.id === stateId);
			if (!state) {
				errors.push(`Parallel group ${groupIndex + 1} references missing state "${stateId}".`);
			} else if (state.kind !== "action") {
				errors.push(`Parallel group ${groupIndex + 1} state "${stateId}" must be an action state.`);
			}
		}
		const hasMatchingFork = machine.transitions.some(
			(transition) =>
				transition.to.length > 1 &&
				group.every((stateId) => transition.to.includes(stateId)) &&
				transition.from.some((stateId) =>
					machine.states.some((state) => state.id === stateId && state.kind === "fork"),
				),
		);
		if (!hasMatchingFork) {
			errors.push(
				`Parallel group ${groupIndex + 1} (${group.join(", ")}) must be activated by a multi-target transition from a fork state.`,
			);
		}
	}

	for (const transition of machine.transitions) {
		if (transitionIds.has(transition.id)) errors.push(`Duplicate transition id "${transition.id}".`);
		transitionIds.add(transition.id);
		for (const stateId of [...transition.from, ...transition.to]) {
			if (!stateIds.has(stateId)) {
				errors.push(`Transition "${transition.id}" references missing state "${stateId}".`);
			}
		}
		for (const condition of transition.guard?.conditions ?? []) {
			if (
				(condition.type === "state_active" || condition.type === "state_completed") &&
				!stateIds.has(condition.stateId)
			) {
				errors.push(`Transition "${transition.id}" guard references missing state "${condition.stateId}".`);
			}
			if (condition.type === "visit_count_lt" && !stateIds.has(condition.stateId)) {
				errors.push(`Transition "${transition.id}" guard references missing state "${condition.stateId}".`);
			}
		}
	}

	for (const state of machine.states) {
		const outgoing = machine.transitions.filter((transition) => transition.from.includes(state.id));
		const incoming = machine.transitions.filter((transition) => transition.to.includes(state.id));
		if (state.kind === "action" && !state.errorPolicy) {
			errors.push(`Action state "${state.id}" must define an error policy.`);
		}
		if (state.kind === "final" && outgoing.length > 0) {
			errors.push(`Final state "${state.id}" must not have outgoing transitions.`);
		}
		if (state.kind !== "final" && state.finalOutcome !== undefined) {
			errors.push(`State "${state.id}" defines finalOutcome but is not final.`);
		}
		if (state.kind === "fork" && !outgoing.some((transition) => transition.to.length > 1)) {
			errors.push(`Fork state "${state.id}" needs an outgoing transition with multiple targets.`);
		}
		if (state.kind === "join" && !incoming.some((transition) => transition.from.length > 1)) {
			errors.push(`Join state "${state.id}" needs an incoming transition with multiple sources.`);
		}
		if (state.kind === "choice" && outgoing.length < 2) {
			errors.push(`Choice state "${state.id}" needs at least two outgoing transitions.`);
		}

		const policy = state.errorPolicy;
		if (!policy) continue;
		if (policy.fallbackStateId && !stateIds.has(policy.fallbackStateId)) {
			errors.push(`State "${state.id}" references missing fallback state "${policy.fallbackStateId}".`);
		}
		if (policy.strategy === "retry" && policy.retryLimit === undefined) {
			errors.push(`State "${state.id}" uses retry without retryLimit.`);
		}
		if (policy.strategy === "fallback" && policy.fallbackStateId === undefined) {
			errors.push(`State "${state.id}" uses fallback without fallbackStateId.`);
		}
		if (policy.strategy === "suppress" && !policy.mayHideFailure) {
			errors.push(`State "${state.id}" uses suppression without declaring mayHideFailure.`);
		}
		if (policy.strategy === "suppress" && !policy.suppressionAllowed) {
			errors.push(`State "${state.id}" uses suppression without state-level approval.`);
		}
		if (policy.mayHideFailure && machine.context.errorSuppression === "forbid") {
			errors.push(`State "${state.id}" may hide failures while error suppression is forbidden.`);
		}
		if (policy.mayHideFailure && machine.context.errorSuppression === "explicit-only") {
			if (!policy.suppressionAllowed || !policy.justification || policy.observableSignals.length === 0) {
				errors.push(
					`State "${state.id}" needs explicit suppression approval, justification, and observable signals.`,
				);
			}
		}
	}

	validateParentHierarchy(machine, errors);

	if (stateIds.has(machine.initialStateId)) {
		const reachable = findReachableStateIds(machine);
		for (const state of machine.states) {
			if (!reachable.has(state.id)) errors.push(`State "${state.id}" is unreachable from the initial state.`);
		}
		if (!machine.states.some((state) => state.kind === "final" && reachable.has(state.id))) {
			errors.push("The machine has no reachable final state.");
		}
	}

	for (const state of machine.states) {
		if (state.acceptanceCriteria.length === 0 && state.kind === "action") {
			warnings.push(`Action state "${state.id}" has no acceptance criteria.`);
		}
	}

	return { ok: errors.length === 0, errors, warnings, machine: errors.length === 0 ? machine : undefined };
}
