import type {
	PlanDispatchResult,
	PlanEffect,
	PlanGuard,
	PlanGuardCondition,
	PlanMachineDefinition,
	PlanRuntimeSnapshot,
	PlanRuntimeStatus,
	PlanState,
	PlanTransition,
} from "./schema.ts";
import { validatePlanMachine } from "./validator.ts";

export class PlanFSMValidationError extends Error {
	readonly errors: string[];

	constructor(errors: string[]) {
		super(`Invalid plan state machine:\n${errors.map((error) => `- ${error}`).join("\n")}`);
		this.name = "PlanFSMValidationError";
		this.errors = errors;
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function sorted(values: Iterable<string>): string[] {
	return [...values].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

export class PlanFSM {
	private readonly definition: PlanMachineDefinition;
	private readonly stateById: ReadonlyMap<string, PlanState>;
	private runtime: PlanRuntimeSnapshot;

	constructor(definition: PlanMachineDefinition, snapshot?: PlanRuntimeSnapshot) {
		const validation = validatePlanMachine(definition);
		if (!validation.ok || !validation.machine) throw new PlanFSMValidationError(validation.errors);
		this.definition = clone(validation.machine);
		this.stateById = new Map(this.definition.states.map((state) => [state.id, state]));
		this.runtime = snapshot ? this.validateSnapshot(snapshot) : this.createInitialSnapshot();
	}

	get machine(): PlanMachineDefinition {
		return clone(this.definition);
	}

	get snapshot(): PlanRuntimeSnapshot {
		return clone(this.runtime);
	}

	start(timestamp = Date.now()): PlanRuntimeSnapshot {
		if (this.runtime.status !== "idle") throw new Error(`Plan FSM is already ${this.runtime.status}.`);
		this.runtime.status = "running";
		this.runtime.activeStateIds = [this.definition.initialStateId];
		this.runtime.visitCounts[this.definition.initialStateId] = 1;
		this.updateTerminalStatus();
		this.runtime.history.push({
			event: "START",
			transitionIds: [],
			activeStateIdsBefore: [],
			activeStateIdsAfter: [...this.runtime.activeStateIds],
			timestamp,
		});
		this.settleAutomaticTransitions(timestamp);
		return this.snapshot;
	}

	getEnabledTransitions(event: string, sourceStateId?: string): PlanTransition[] {
		if (this.runtime.status !== "running") return [];
		const active = new Set(this.runtime.activeStateIds);
		const enabled = this.definition.transitions
			.filter((transition) => transition.event === event)
			.filter((transition) => !sourceStateId || transition.from.includes(sourceStateId))
			.filter((transition) => transition.from.every((stateId) => active.has(stateId)))
			.filter((transition) => this.evaluateGuard(transition.guard))
			.sort(
				(left, right) =>
					(right.priority ?? 0) - (left.priority ?? 0) ||
					left.id.localeCompare(right.id, undefined, { numeric: true }),
			);
		return clone(enabled);
	}

	dispatch(
		event: string,
		options: { sourceStateId?: string; evidence?: string; timestamp?: number } = {},
	): PlanDispatchResult {
		if (this.runtime.status !== "running") {
			throw new Error(`Cannot dispatch event while Plan FSM is ${this.runtime.status}.`);
		}

		const activeBefore = new Set(this.runtime.activeStateIds);
		const selected: PlanTransition[] = [];
		const consumedSources = new Set<string>();
		for (const transition of this.getEnabledTransitions(event, options.sourceStateId)) {
			if (transition.from.some((stateId) => consumedSources.has(stateId))) continue;
			selected.push(transition);
			for (const stateId of transition.from) consumedSources.add(stateId);
		}

		if (selected.length === 0) {
			return { appliedTransitionIds: [], snapshot: this.snapshot };
		}

		if (this.runtime.transitionCount + selected.length > this.definition.limits.maxTransitions) {
			this.block(`Transition limit ${this.definition.limits.maxTransitions} exceeded.`);
			return { appliedTransitionIds: [], snapshot: this.snapshot };
		}

		const targets = new Set(selected.flatMap((transition) => transition.to));
		for (const stateId of targets) {
			const nextVisits = (this.runtime.visitCounts[stateId] ?? 0) + 1;
			const limit = this.stateById.get(stateId)?.maxVisits ?? this.definition.limits.defaultMaxVisitsPerState;
			if (nextVisits > limit) {
				this.block(`State "${stateId}" visit limit ${limit} exceeded.`);
				return { appliedTransitionIds: [], snapshot: this.snapshot };
			}
		}

		const nextActive = new Set(activeBefore);
		const completed = new Set(this.runtime.completedStateIds);
		for (const transition of selected) {
			for (const stateId of transition.from) {
				nextActive.delete(stateId);
				completed.add(stateId);
			}
			for (const stateId of transition.to) nextActive.add(stateId);
			for (const effect of transition.effects ?? []) this.applyEffect(effect);
		}
		for (const stateId of targets) {
			this.runtime.visitCounts[stateId] = (this.runtime.visitCounts[stateId] ?? 0) + 1;
		}

		this.runtime.activeStateIds = sorted(nextActive);
		this.runtime.completedStateIds = sorted(completed);
		this.runtime.transitionCount += selected.length;
		this.runtime.history.push({
			event,
			sourceStateId: options.sourceStateId,
			evidence: options.evidence,
			transitionIds: selected.map((transition) => transition.id),
			activeStateIdsBefore: sorted(activeBefore),
			activeStateIdsAfter: [...this.runtime.activeStateIds],
			timestamp: options.timestamp ?? Date.now(),
		});
		this.updateTerminalStatus();
		if (event !== "AUTO") this.settleAutomaticTransitions(options.timestamp ?? Date.now());

		return { appliedTransitionIds: selected.map((transition) => transition.id), snapshot: this.snapshot };
	}

	private settleAutomaticTransitions(timestamp: number): void {
		while (this.runtime.status === "running") {
			const before = this.runtime.transitionCount;
			const result = this.dispatch("AUTO", { timestamp });
			if (result.appliedTransitionIds.length === 0 || this.runtime.transitionCount === before) return;
		}
	}

	private createInitialSnapshot(): PlanRuntimeSnapshot {
		return {
			machineId: this.definition.id,
			status: "idle",
			activeStateIds: [],
			completedStateIds: [],
			visitCounts: {},
			transitionCount: 0,
			context: clone(this.definition.context.variables),
			history: [],
		};
	}

	private validateSnapshot(snapshot: PlanRuntimeSnapshot): PlanRuntimeSnapshot {
		if (snapshot.machineId !== this.definition.id) {
			throw new Error(`Snapshot belongs to machine "${snapshot.machineId}", expected "${this.definition.id}".`);
		}
		for (const stateId of [
			...snapshot.activeStateIds,
			...snapshot.completedStateIds,
			...Object.keys(snapshot.visitCounts),
		]) {
			if (!this.stateById.has(stateId)) throw new Error(`Snapshot references missing state "${stateId}".`);
		}
		if (snapshot.transitionCount > this.definition.limits.maxTransitions) {
			throw new Error("Snapshot exceeds the machine transition limit.");
		}
		return clone(snapshot);
	}

	private evaluateGuard(guard: PlanGuard | undefined): boolean {
		if (!guard) return true;
		const results = guard.conditions.map((condition) => this.evaluateCondition(condition));
		return guard.mode === "all" ? results.every(Boolean) : results.some(Boolean);
	}

	private evaluateCondition(condition: PlanGuardCondition): boolean {
		switch (condition.type) {
			case "context_equals":
				return Object.is(this.runtime.context[condition.key], condition.value);
			case "context_not_equals":
				return !Object.is(this.runtime.context[condition.key], condition.value);
			case "context_truthy":
				return Boolean(this.runtime.context[condition.key]);
			case "state_active":
				return this.runtime.activeStateIds.includes(condition.stateId);
			case "state_completed":
				return this.runtime.completedStateIds.includes(condition.stateId);
			case "visit_count_lt":
				return (this.runtime.visitCounts[condition.stateId] ?? 0) < condition.value;
			case "transition_count_lt":
				return this.runtime.transitionCount < condition.value;
		}
	}

	private applyEffect(effect: PlanEffect): void {
		switch (effect.type) {
			case "set_context":
				this.runtime.context[effect.key] = effect.value;
				break;
			case "increment_context": {
				const current = this.runtime.context[effect.key];
				this.runtime.context[effect.key] = (typeof current === "number" ? current : 0) + effect.by;
				break;
			}
		}
	}

	private block(reason: string): void {
		this.runtime.status = "blocked";
		this.runtime.blockReason = reason;
	}

	private updateTerminalStatus(): void {
		if (this.runtime.activeStateIds.length === 0) return;
		const activeStates = this.runtime.activeStateIds.map((stateId) => this.stateById.get(stateId)!);
		if (!activeStates.every((state) => state.kind === "final")) return;
		const outcomes = activeStates.map((state) => state.finalOutcome ?? "success");
		let status: PlanRuntimeStatus = "completed";
		if (outcomes.includes("failure")) status = "failed";
		else if (outcomes.includes("blocked")) status = "blocked";
		this.runtime.status = status;
	}
}
