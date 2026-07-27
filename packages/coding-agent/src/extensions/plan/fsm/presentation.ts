import type { PlanMachineDefinition, PlanRuntimeSnapshot, PlanState, PlanTransition } from "./schema.ts";

function stateLabel(state: PlanState): string {
	return `${state.id}: ${state.title} [${state.kind} · ${state.abstraction} · ${state.role}]`;
}

function transitionLabel(transition: PlanTransition): string {
	return `${transition.id}: ${transition.from.join(" + ")} --${transition.event}--> ${transition.to.join(" + ")}`;
}

export function formatPlanMachine(machine: PlanMachineDefinition): string {
	const lines = [
		`Goal: ${machine.goal}`,
		`Scheduling: ${machine.parallelism.strategy} — ${machine.parallelism.rationale}`,
		`Initial state: ${machine.initialStateId}`,
		"",
		"States:",
	];

	for (const state of machine.states) {
		lines.push(`- ${stateLabel(state)}`);
	}

	lines.push("", "Transitions:");
	for (const transition of machine.transitions) {
		lines.push(`- ${transitionLabel(transition)}`);
	}
	return lines.join("\n");
}

export function formatPlanRuntime(machine: PlanMachineDefinition, snapshot: PlanRuntimeSnapshot): string {
	const stateById = new Map(machine.states.map((state) => [state.id, state]));
	const active = snapshot.activeStateIds
		.map((stateId) => stateById.get(stateId))
		.filter((state) => state !== undefined);
	const lines = [
		`Plan status: ${snapshot.status}`,
		`Goal: ${machine.goal}`,
		`Active states: ${active.length > 0 ? active.map((state) => stateLabel(state)).join(", ") : "none"}`,
		`Transitions applied: ${snapshot.transitionCount}/${machine.limits.maxTransitions}`,
	];
	if (snapshot.blockReason) lines.push(`Block reason: ${snapshot.blockReason}`);
	return lines.join("\n");
}

export function formatPlanWidget(machine: PlanMachineDefinition, snapshot: PlanRuntimeSnapshot): string[] {
	const active = new Set(snapshot.activeStateIds);
	const completed = new Set(snapshot.completedStateIds);
	return machine.states.map((state) => {
		const marker = active.has(state.id) ? "▶" : completed.has(state.id) ? "✓" : "○";
		return `${marker} ${state.title} (${state.role})`;
	});
}

export function formatActiveStateInstructions(machine: PlanMachineDefinition, snapshot: PlanRuntimeSnapshot): string {
	const stateById = new Map(machine.states.map((state) => [state.id, state]));
	return snapshot.activeStateIds
		.map((stateId) => stateById.get(stateId))
		.filter((state) => state !== undefined)
		.map((state) => {
			const lines = [stateLabel(state)];
			if (state.instruction) lines.push(`  Instruction: ${state.instruction}`);
			if (state.acceptanceCriteria.length > 0) {
				lines.push(`  Acceptance: ${state.acceptanceCriteria.join("; ")}`);
			}
			if (state.errorPolicy) {
				lines.push(
					`  Error policy: ${state.errorPolicy.strategy}; mayHideFailure=${state.errorPolicy.mayHideFailure}; suppressionAllowed=${state.errorPolicy.suppressionAllowed}`,
				);
			}
			return lines.join("\n");
		})
		.join("\n");
}

export function formatEnabledTransitions(transitions: PlanTransition[]): string {
	if (transitions.length === 0) return "none";
	return transitions.map((transition) => `- ${transitionLabel(transition)}`).join("\n");
}
