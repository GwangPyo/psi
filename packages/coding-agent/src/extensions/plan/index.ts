/**
 * Plan Mode Extension
 *
 * Read-only exploration produces a validated PlanFSM. Execution advances the
 * persisted machine through explicit, structured transition tool calls.
 */

import { Key } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { type AnimatedStatus, startAnimatedStatus } from "../animated-status.ts";
import {
	formatActiveStateInstructions,
	formatEnabledTransitions,
	formatPlanMachine,
	formatPlanRuntime,
	formatPlanWidget,
	PlanFSM,
	type PlanMachineDefinition,
	PlanParallelismSchema,
	type PlanRuntimeSnapshot,
	PlanScalarSchema,
	PlanStateSchema,
	type PlanTransition,
	PlanTransitionSchema,
} from "./fsm/index.ts";
import { isSafeCommand } from "./utils.ts";

const SUBMIT_PLAN_TOOL = "submit_plan_machine";
const TRANSITION_PLAN_TOOL = "plan_transition";
const PLAN_DRAFTING_WIDGET = "plan-drafting";
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", SUBMIT_PLAN_TOOL];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", TRANSITION_PLAN_TOOL]);
const PLAN_CONTROL_TOOLS = new Set<string>([SUBMIT_PLAN_TOOL, TRANSITION_PLAN_TOOL]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS, ...PLAN_CONTROL_TOOLS]);

const PlanTransitionParameters = Type.Object({
	event: Type.String({ minLength: 1, description: "Exact event name on the transition to dispatch" }),
	sourceStateId: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Active source state to advance; omit to dispatch all matching branches",
		}),
	),
	evidence: Type.String({
		minLength: 1,
		description: "Concrete evidence that the source state's acceptance criteria or control condition is satisfied",
	}),
});

const ErrorSuppressionSchema = Type.Union([
	Type.Literal("forbid"),
	Type.Literal("explicit-only"),
	Type.Literal("allow"),
]);

const PlanMachineDraftSchema = Type.Object({
	version: Type.Optional(Type.Literal(1)),
	id: Type.Optional(Type.String({ minLength: 1, description: "Stable identifier for this plan" })),
	goal: Type.Optional(Type.String({ minLength: 1, description: "The complete user goal this plan must achieve" })),
	initialStateId: Type.Optional(Type.String({ minLength: 1, description: "State activated when execution begins" })),
	parallelism: Type.Optional(PlanParallelismSchema),
	context: Type.Optional(
		Type.Object({
			variables: Type.Optional(
				Type.Record(Type.String(), PlanScalarSchema, { description: "Initial scalar runtime variables" }),
			),
			errorSuppression: Type.Optional(ErrorSuppressionSchema),
		}),
	),
	errorSuppression: Type.Optional(
		Type.Unsafe<"forbid" | "explicit-only" | "allow">({
			...ErrorSuppressionSchema,
			description: "Accepted top-level alias for context.errorSuppression",
		}),
	),
	states: Type.Optional(Type.Array(PlanStateSchema, { minItems: 1, description: "Complete set of PlanFSM states" })),
	transitions: Type.Optional(
		Type.Array(PlanTransitionSchema, { description: "Complete set of guarded PlanFSM transitions" }),
	),
	limits: Type.Optional(
		Type.Object({
			maxTransitions: Type.Optional(Type.Integer({ minimum: 1 })),
			defaultMaxVisitsPerState: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
	),
});

type PlanMachineDraft = Static<typeof PlanMachineDraftSchema>;

function mergePlanMachineDraft(current: PlanMachineDraft, update: PlanMachineDraft): PlanMachineDraft {
	return {
		...current,
		...update,
		context:
			current.context || update.context
				? {
						...current.context,
						...update.context,
						variables: {
							...current.context?.variables,
							...update.context?.variables,
						},
					}
				: undefined,
		limits:
			current.limits || update.limits
				? {
						...current.limits,
						...update.limits,
					}
				: undefined,
	};
}

function materializePlanMachineDraft(draft: PlanMachineDraft): {
	machine?: PlanMachineDefinition;
	missing: string[];
} {
	const { goal, id, initialStateId, parallelism, states, transitions } = draft;
	const missing: string[] = [];
	if (!id) missing.push("id");
	if (!goal) missing.push("goal");
	if (!initialStateId) missing.push("initialStateId");
	if (!parallelism) missing.push("parallelism");
	if (!states) missing.push("states");
	if (!transitions) missing.push("transitions");
	if (missing.length > 0 || !id || !goal || !initialStateId || !parallelism || !states || !transitions) {
		return { missing };
	}

	return {
		missing,
		machine: {
			version: 1,
			id,
			goal,
			initialStateId,
			parallelism,
			context: {
				variables: draft.context?.variables ?? {},
				errorSuppression: draft.context?.errorSuppression ?? draft.errorSuppression ?? "forbid",
			},
			states,
			transitions,
			limits: {
				maxTransitions: draft.limits?.maxTransitions ?? Math.max(30, states.length * 4),
				defaultMaxVisitsPerState: draft.limits?.defaultMaxVisitsPerState ?? 3,
			},
		},
	};
}

function formatPlanMachineDraftStatus(draft: PlanMachineDraft): string {
	const supplied = Object.keys(draft);
	if (supplied.length === 0) return "No PlanFSM draft fields have been submitted yet.";
	const { missing } = materializePlanMachineDraft(draft);
	return [
		`Stored draft fields: ${supplied.join(", ")}.`,
		missing.length > 0 ? `Still required: ${missing.join(", ")}.` : "All required top-level fields are present.",
	].join(" ");
}

interface PlanModeState {
	enabled: boolean;
	executing: boolean;
	machine?: PlanMachineDefinition;
	snapshot?: PlanRuntimeSnapshot;
	draft?: PlanMachineDraft;
	toolsBeforePlanMode?: string[];
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

function withoutPlanControlTools(toolNames: string[]): string[] {
	return toolNames.filter((name) => !PLAN_CONTROL_TOOLS.has(name));
}

function getEnabledTransitions(fsm: PlanFSM): PlanTransition[] {
	const events = new Set(fsm.machine.transitions.map((transition) => transition.event));
	const transitions = [...events].flatMap((event) => fsm.getEnabledTransitions(event));
	return transitions.sort(
		(left, right) =>
			(right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id, undefined, { numeric: true }),
	);
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let machineDefinition: PlanMachineDefinition | undefined;
	let runtimeSnapshot: PlanRuntimeSnapshot | undefined;
	let machineDraft: PlanMachineDraft = {};
	let toolsBeforePlanMode: string[] | undefined;
	let planSubmittedThisRun = false;
	let planAgentRunning = false;
	let draftingStatus: AnimatedStatus | undefined;

	function stopDraftingStatus(): void {
		draftingStatus?.stop();
		draftingStatus = undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && machineDefinition && runtimeSnapshot) {
			stopDraftingStatus();
			const completed = machineDefinition.states.filter(
				(state) => state.kind !== "final" && runtimeSnapshot?.completedStateIds.includes(state.id),
			).length;
			const total = machineDefinition.states.filter((state) => state.kind !== "final").length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `plan ${completed}/${total}`));
			ctx.ui.setWidget("plan-todos", formatPlanWidget(machineDefinition, runtimeSnapshot));
			return;
		}

		if (planModeEnabled) {
			if (!machineDefinition && planAgentRunning) {
				const label = "plan drafting";
				ctx.ui.setStatus("plan-mode", undefined);
				if (draftingStatus) {
					draftingStatus.setLabel(label);
				} else {
					draftingStatus = startAnimatedStatus({
						label,
						setStatus: (text) =>
							ctx.ui.setWidget(PLAN_DRAFTING_WIDGET, text ? [text] : undefined, { placement: "aboveEditor" }),
						render: (frame, text) => `${ctx.ui.theme.fg("accent", frame)} ${ctx.ui.theme.fg("warning", text)}`,
					});
				}
				ctx.ui.setWidget("plan-todos", undefined);
				return;
			}

			stopDraftingStatus();
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", machineDefinition ? "plan ready" : "plan drafting"));
			ctx.ui.setWidget(
				"plan-todos",
				machineDefinition && runtimeSnapshot ? formatPlanWidget(machineDefinition, runtimeSnapshot) : undefined,
			);
			return;
		}

		stopDraftingStatus();
		ctx.ui.setStatus("plan-mode", undefined);
		ctx.ui.setWidget("plan-todos", undefined);
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...withoutPlanControlTools(activeToolNames).filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...withoutPlanControlTools(activeToolNames).filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = withoutPlanControlTools(pi.getActiveTools());
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function enableExecutionTools(): void {
		const baseTools = toolsBeforePlanMode ?? withoutPlanControlTools(pi.getActiveTools());
		pi.setActiveTools(uniqueToolNames([...getNormalModeTools(baseTools), TRANSITION_PLAN_TOOL]));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry<PlanModeState>("plan-mode", {
			enabled: planModeEnabled,
			executing: executionMode,
			machine: machineDefinition,
			snapshot: runtimeSnapshot,
			draft: machineDraft,
			toolsBeforePlanMode,
		});
	}

	function clearPlan(): void {
		stopDraftingStatus();
		machineDefinition = undefined;
		runtimeSnapshot = undefined;
		machineDraft = {};
		planSubmittedThisRun = false;
		planAgentRunning = false;
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			planModeEnabled = false;
			executionMode = false;
			clearPlan();
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		} else {
			planModeEnabled = true;
			executionMode = false;
			clearPlan();
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Submit a PlanFSM before execution.");
		}
		updateStatus(ctx);
		persistState();
	}

	function finishExecution(ctx: ExtensionContext): void {
		if (!machineDefinition || !runtimeSnapshot) return;
		executionMode = false;
		restoreNormalModeTools();
		updateStatus(ctx);
		persistState();
		pi.sendMessage(
			{
				customType: "plan-complete",
				content: formatPlanRuntime(machineDefinition, runtimeSnapshot),
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	pi.registerFlag("plan", {
		description: "Start in PlanFSM mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: SUBMIT_PLAN_TOOL,
		label: "Submit PlanFSM",
		description:
			"Build and submit the finite-state-machine plan after read-only exploration. Partial calls are accumulated, missing fields are reported, and the completed machine is validated for references, reachability, forks, joins, bounded loops, and error-suppression policy.",
		promptSnippet: "Submit a validated nonlinear PlanFSM while plan mode is active",
		promptGuidelines: [
			"In plan mode, call submit_plan_machine until it reports that the PlanFSM was accepted; partial calls are retained.",
			"Analyze dependencies before ordering states. Put every independent branch-entry set in parallelism.independentStateGroups and activate each set with a multi-target fork transition.",
			"Use sequential strategy only when the rationale names the concrete dependency that forces every action to wait.",
			"Represent revision and retry paths with bounded loops.",
		],
		parameters: PlanMachineDraftSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled) throw new Error("submit_plan_machine is only available while plan mode is active.");
			machineDraft = mergePlanMachineDraft(machineDraft, params);
			const materialized = materializePlanMachineDraft(machineDraft);
			if (!materialized.machine) {
				persistState();
				return {
					content: [
						{
							type: "text",
							text: `PlanFSM draft saved. Missing required fields: ${materialized.missing.join(", ")}. Call submit_plan_machine again with the missing fields; previously supplied fields are retained.`,
						},
					],
					details: { accepted: false, missing: materialized.missing, draft: machineDraft },
				};
			}

			const fsm = new PlanFSM(materialized.machine);
			machineDefinition = fsm.machine;
			runtimeSnapshot = fsm.snapshot;
			planSubmittedThisRun = true;
			updateStatus(ctx);
			persistState();
			return {
				content: [{ type: "text", text: `PlanFSM accepted.\n\n${formatPlanMachine(machineDefinition)}` }],
				details: { machine: machineDefinition, snapshot: runtimeSnapshot },
			};
		},
	});

	pi.registerTool({
		name: TRANSITION_PLAN_TOOL,
		label: "Advance PlanFSM",
		description:
			"Advance the executing PlanFSM through an enabled transition. Use the exact event and optional source state shown in the execution context, with concrete acceptance evidence.",
		promptSnippet: "Advance active PlanFSM states with explicit events and evidence",
		promptGuidelines: [
			"During plan execution, call plan_transition after satisfying an active state's acceptance criteria.",
			"Use FAILURE, retry, or fallback transitions when criteria are not met; never report success without evidence.",
		],
		parameters: PlanTransitionParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!executionMode || !machineDefinition || !runtimeSnapshot) {
				throw new Error("No PlanFSM is currently executing.");
			}

			const fsm = new PlanFSM(machineDefinition, runtimeSnapshot);
			const enabledBefore = getEnabledTransitions(fsm);
			const result = fsm.dispatch(params.event, {
				sourceStateId: params.sourceStateId,
				evidence: params.evidence,
			});
			if (result.appliedTransitionIds.length === 0 && result.snapshot.status === "running") {
				throw new Error(
					`No transition accepted event "${params.event}"${params.sourceStateId ? ` from "${params.sourceStateId}"` : ""}.\nEnabled transitions:\n${formatEnabledTransitions(enabledBefore)}`,
				);
			}

			runtimeSnapshot = result.snapshot;
			updateStatus(ctx);
			persistState();
			const runtimeText = formatPlanRuntime(machineDefinition, runtimeSnapshot);
			const nextTransitions = getEnabledTransitions(new PlanFSM(machineDefinition, runtimeSnapshot));
			const responseText = `${runtimeText}\n\nNext enabled transitions:\n${formatEnabledTransitions(nextTransitions)}`;

			if (runtimeSnapshot.status !== "running") finishExecution(ctx);
			return {
				content: [{ type: "text", text: responseText }],
				details: {
					appliedTransitionIds: result.appliedTransitionIds,
					evidence: params.evidence,
					snapshot: runtimeSnapshot,
				},
			};
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle PlanFSM mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show the current PlanFSM and runtime state",
		handler: async (_args, ctx) => {
			if (!machineDefinition || !runtimeSnapshot) {
				ctx.ui.notify("No PlanFSM. Create one with /plan.", "info");
				return;
			}
			ctx.ui.notify(
				`${formatPlanRuntime(machineDefinition, runtimeSnapshot)}\n\n${formatPlanMachine(machineDefinition)}`,
				"info",
			);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle PlanFSM mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;
		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked by the read-only allowlist.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => {
				const customType = "customType" in message ? message.customType : undefined;
				if (customType === "plan-mode-context" && !planModeEnabled) return false;
				if (customType === "plan-execution-context" && !executionMode) return false;
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are constructing an executable PlanFSM, not writing a prose todo list. Explore with read-only tools and call ${SUBMIT_PLAN_TOOL} until it reports "PlanFSM accepted."

Current submission state:
${formatPlanMachineDraftStatus(machineDraft)}

Planning procedure:
1. Establish the goal and evidence boundary.
   - Restate the complete user outcome in goal without shrinking its scope.
   - Identify repository rules, user constraints, named deliverables, tests, runtime behavior, and evidence required to prove completion.
   - Resolve important unknowns through read-only inspection. Ask the user only when a choice materially changes the result and cannot be discovered.

2. Inspect the existing system before proposing implementation.
   - Locate relevant entry points, data flow, public contracts, tests, configuration, and error handling.
   - Search for existing functions, libraries, helpers, and abstractions that already provide each needed capability.
   - Put reuse and contract checks in state instructions and acceptanceCriteria. Do not create duplicate implementation states when an existing capability can be reused or extended.
   - Record assumptions as context.variables when a later guard or choice depends on them.

3. Decompose top-down.
   - Use abstraction levels goal, system, component, implementation, and verification.
   - parentId expresses conceptual ownership or decomposition. It does not create an execution dependency; transitions do that.
   - Each executable action state must have one bounded responsibility, an explicit role, a concrete instruction, measurable acceptanceCriteria, and an errorPolicy.
   - Keep states large enough to represent meaningful outcomes and small enough that their evidence can be checked independently.

4. Build the dependency graph before choosing an order.
   - For every pair of action states, ask whether one consumes an artifact, decision, contract, or verified result produced by the other.
   - Add a serial transition only for a real data, control, resource-conflict, or user-decision dependency.
   - States sharing a predecessor with no dependency on one another are parallel candidates. Activate them together from a fork state with one multi-target transition.
   - Synchronize parallel branches with a multi-source transition into a join state before shared verification or integration.
   - File proximity or planning convenience alone does not justify serialization.
   - Set parallelism.strategy to parallel when any independent group exists. List each branch-entry group in independentStateGroups and explain remaining dependencies in rationale.
   - Set strategy to sequential only when every action is dependency-constrained; rationale must name those concrete predecessor relationships.

5. Choose state kinds by runtime meaning.
   - action: work that produces independently verifiable evidence.
   - choice: a decision point with at least two guarded outgoing transitions. Guards should be mutually understandable and priorities deterministic.
   - fork: structural state whose outgoing transition activates multiple branch-entry states at once.
   - join: structural convergence reached by a transition whose from array contains every required branch-completion state.
   - final: terminal success, failure, or blocked outcome. Final states have no outgoing transitions.

6. Define transitions as executable hyperedges.
   - from and to are arrays. A transition is enabled only when every from state is active and its guard passes.
   - Use stable IDs and exact, meaningful event names. Include success, failure, retry, fallback, and decision events needed by execution.
   - Use effects only for scalar context updates needed by later guards.
   - Every non-final state needs a viable outgoing path, every state must be reachable, and at least one final state must be reachable.

7. Model failure explicitly.
   - propagate exposes the original failure; translate exposes a domain-level failure; retry uses retryLimit; fallback names fallbackStateId; suppress requires explicit approval.
   - Set mayHideFailure truthfully. suppressionAllowed is true only with actual authorization. When hiding is possible, provide justification and observableSignals.
   - Default to visible failure. Never use try/catch or fallback merely to make execution appear successful.

8. Bound every cycle.
   - Revision and retry loops require maxVisits and/or visit_count_lt or transition_count_lt guards.
   - Provide an exit path to success, failure, or blocked. Set global maxTransitions high enough for valid retries and low enough to stop runaway execution.

9. Design verification as part of the graph.
   - acceptanceCriteria must name observable evidence such as exact tests, type checks, runtime probes, changed contracts, or inspected artifacts.
   - Put shared integration verification after joins. Keep branch-local verification inside its branch when it does not depend on other branches.
   - A success transition is valid only after its source acceptanceCriteria can be supported by concrete evidence.

10. Audit the complete machine before submission.
   - Check IDs and references, reachability, final outcomes, parent hierarchy, guard variables, error policies, loop bounds, fork targets, join sources, and transition limits.
   - Look for accidental linear chains. Convert independent siblings into fork/join branches.
   - Confirm the machine still covers the user's full goal and every named deliverable.

Submission protocol:
- ${SUBMIT_PLAN_TOOL} retains partial top-level fields and reports what is missing.
- A reliable split is: metadata/context/parallelism first, the complete states array second, and the complete transitions array plus limits third.
- Each later states or transitions field replaces that whole stored array. Send the complete corrected array when fixing it; do not send array fragments across calls.
- Validation errors identify structural corrections. Resubmit the corrected field while relying on the stored draft for unchanged fields.
- Do not present a numbered plan as the authoritative artifact. Planning finishes only after the tool accepts the machine.

Canonical parallel shape:
- an action produces shared prerequisites;
- it transitions to a fork;
- one fork transition activates two or more independent action states;
- a multi-source transition consumes all completed branch states into a join;
- the join transitions to shared verification and then a final state.

Keep built-in write tools disabled throughout planning.`,
					display: false,
				},
			};
		}

		if (executionMode && machineDefinition && runtimeSnapshot) {
			const fsm = new PlanFSM(machineDefinition, runtimeSnapshot);
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN FSM - Full tool access enabled]
${formatPlanRuntime(machineDefinition, runtimeSnapshot)}

Active state contracts:
${formatActiveStateInstructions(machineDefinition, runtimeSnapshot)}

Enabled transitions:
${formatEnabledTransitions(getEnabledTransitions(fsm))}

Work only on active states. Verify their acceptance criteria, then call ${TRANSITION_PLAN_TOOL} with the exact event and concrete evidence. Parallel active states may advance independently. A join transition becomes enabled only after all source states are active. Follow failure, retry, fallback, and loop transitions when success criteria are not met.`,
					display: false,
				},
			};
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!planModeEnabled || machineDefinition) return;
		planAgentRunning = true;
		updateStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		planAgentRunning = false;
		updateStatus(ctx);
		if (!planModeEnabled || !planSubmittedThisRun || !machineDefinition || !runtimeSnapshot || !ctx.hasUI) return;
		planSubmittedThisRun = false;

		const planMessage = {
			customType: "plan-machine",
			content: formatPlanMachine(machineDefinition),
			display: true,
		};
		const choice = await ctx.ui.select("PlanFSM ready", ["Execute the plan", "Stay in plan mode", "Refine the plan"]);

		if (choice === "Execute the plan") {
			const fsm = new PlanFSM(machineDefinition, runtimeSnapshot);
			runtimeSnapshot = fsm.start();
			planModeEnabled = false;
			executionMode = true;
			enableExecutionTools();
			updateStatus(ctx);
			persistState();
			pi.sendMessage(planMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{
					customType: "plan-mode-execute",
					content: `Execute the active PlanFSM states.\n\n${formatPlanRuntime(machineDefinition, runtimeSnapshot)}`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the PlanFSM:", "");
			if (refinement?.trim()) {
				clearPlan();
				updateStatus(ctx);
				persistState();
				pi.sendMessage(planMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		stopDraftingStatus();
		planAgentRunning = false;
		planModeEnabled = pi.getFlag("plan") === true;
		const entry = ctx.sessionManager
			.getEntries()
			.filter(
				(candidate: { type: string; customType?: string }) =>
					candidate.type === "custom" && candidate.customType === "plan-mode",
			)
			.pop() as { data?: PlanModeState } | undefined;

		if (entry?.data) {
			planModeEnabled = entry.data.enabled ?? planModeEnabled;
			executionMode = entry.data.executing ?? false;
			toolsBeforePlanMode = entry.data.toolsBeforePlanMode;
			machineDraft = entry.data.draft ?? {};
			if (entry.data.machine && entry.data.snapshot) {
				try {
					const restored = new PlanFSM(entry.data.machine, entry.data.snapshot);
					machineDefinition = restored.machine;
					runtimeSnapshot = restored.snapshot;
				} catch (error) {
					planModeEnabled = false;
					executionMode = false;
					clearPlan();
					ctx.ui.notify(`Stored PlanFSM could not be restored: ${String(error)}`, "warning");
				}
			}
		}

		if (executionMode && runtimeSnapshot?.status === "running") enableExecutionTools();
		else if (planModeEnabled) enablePlanModeTools();
		else pi.setActiveTools(withoutPlanControlTools(pi.getActiveTools()));
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		planAgentRunning = false;
		stopDraftingStatus();
		ctx.ui.setStatus("plan-mode", undefined);
		ctx.ui.setWidget(PLAN_DRAFTING_WIDGET, undefined);
	});
}
