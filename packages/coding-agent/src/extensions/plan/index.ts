/**
 * Plan Mode Extension
 *
 * Read-only exploration produces a validated PlanFSM. Execution advances the
 * persisted machine through explicit, structured transition tool calls.
 */

import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { type AnimatedStatus, startAnimatedStatus } from "../animated-status.ts";
import {
	formatActiveStateInstructions,
	formatEnabledTransitions,
	formatPlanMachine,
	formatPlanRuntime,
	formatPlanWidget,
	popupPlanGraph,
	PlanFSM,
	type PlanMachineDefinition,
	type PlanRuntimeSnapshot,
	type PlanTransition,
} from "./fsm/index.ts";
import {
	applyPlanGuideCommand,
	createPlanGuideDraft,
	formatPlanGuideStatus,
	PlanGuideCommandSchema,
	type PlanGuideDraft,
} from "./guide.ts";
import { isSafeCommand } from "./utils.ts";

const GUIDE_PLAN_TOOL = "guide_plan";
const TRANSITION_PLAN_TOOL = "plan_transition";
const PLAN_DRAFTING_WIDGET = "plan-drafting";
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", GUIDE_PLAN_TOOL];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", TRANSITION_PLAN_TOOL]);
const PLAN_CONTROL_TOOLS = new Set<string>([GUIDE_PLAN_TOOL, TRANSITION_PLAN_TOOL]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS, ...PLAN_CONTROL_TOOLS]);

const PlanTransitionParameters = Type.Object({
	event: Type.String({ minLength: 1, description: "Exact event name on the transition to dispatch" }),
	sourceStateId: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Active source state to advance; omit to dispatch all matching branches",
		}),
	),
	rationale: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Optional reasoning or rationale for this transition (e.g., 'tests passed', 'user confirmed')",
		}),
	),
});

interface PlanModeState {
	enabled: boolean;
	executing: boolean;
	grillBeforePlanning?: boolean;
	machine?: PlanMachineDefinition;
	snapshot?: PlanRuntimeSnapshot;
	draft?: PlanGuideDraft;
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
	let grillBeforePlanning = false;
	let machineDefinition: PlanMachineDefinition | undefined;
	let runtimeSnapshot: PlanRuntimeSnapshot | undefined;
	let planGuideDraft = createPlanGuideDraft();
	let toolsBeforePlanMode: string[] | undefined;
	let planSubmittedThisRun = false;
	let planAgentRunning = false;
	let draftingStatus: AnimatedStatus | undefined;
	let executionKickoffPending = false;
	let executionContinuationPending = false;
	let executionRunTransitionCount: number | undefined;
	let noProgressRuns = 0;

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
		if (!pi.getActiveTools().includes(TRANSITION_PLAN_TOOL)) {
			throw new Error(`Cannot enter plan execution because required tool "${TRANSITION_PLAN_TOOL}" is unavailable.`);
		}
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry<PlanModeState>("plan-mode", {
			enabled: planModeEnabled,
			executing: executionMode,
			grillBeforePlanning,
			machine: machineDefinition,
			snapshot: runtimeSnapshot,
			draft: planGuideDraft,
			toolsBeforePlanMode,
		});
	}

	function clearPlan(): void {
		stopDraftingStatus();
		machineDefinition = undefined;
		runtimeSnapshot = undefined;
		planGuideDraft = createPlanGuideDraft();
		planSubmittedThisRun = false;
		planAgentRunning = false;
		executionKickoffPending = false;
		executionContinuationPending = false;
		executionRunTransitionCount = undefined;
		noProgressRuns = 0;
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		if (planModeEnabled) {
			planModeEnabled = false;
			executionMode = false;
			grillBeforePlanning = false;
			clearPlan();
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		} else {
			grillBeforePlanning = ctx.hasUI
				? await ctx.ui.confirm("Grill you?", "Inspect the implementation before making the plan.")
				: false;
			planModeEnabled = true;
			executionMode = false;
			clearPlan();
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Build a topology guide before execution.");
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

	function blockExecution(ctx: ExtensionContext, reason: string): void {
		if (!runtimeSnapshot) return;
		runtimeSnapshot = {
			...runtimeSnapshot,
			status: "blocked",
			blockReason: reason,
			history: [
				...runtimeSnapshot.history,
				{
					event: "HARNESS_BLOCKED",
					evidence: reason,
					transitionIds: [],
					activeStateIdsBefore: [...runtimeSnapshot.activeStateIds],
					activeStateIdsAfter: [...runtimeSnapshot.activeStateIds],
					timestamp: Date.now(),
				},
			],
		};
		finishExecution(ctx);
	}

	function executionContext(): string {
		if (!machineDefinition || !runtimeSnapshot) return "No executable PlanFSM is loaded.";
		const fsm = new PlanFSM(machineDefinition, runtimeSnapshot);
		return `[EXECUTING PLAN FSM - Full tool access enabled]
${formatPlanRuntime(machineDefinition, runtimeSnapshot)}

Active state contracts:
${formatActiveStateInstructions(machineDefinition, runtimeSnapshot)}

Enabled transitions:
${formatEnabledTransitions(getEnabledTransitions(fsm))}

Treat every active action as a required postcondition. Inspect the current workspace, establish any missing outcome, verify every acceptance criterion, and call ${TRANSITION_PLAN_TOOL}.
Parallel active states are one ready frontier: advance any state without waiting for unrelated states. Structural AUTO transitions are settled by the runtime.
An execution run may end only after dispatching a transition, reaching a terminal state, or reporting a concrete externally blocked condition. Never wait for another system instruction while the PlanFSM is running.`;
	}

	pi.registerFlag("plan", {
		description: "Start in PlanFSM mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: GUIDE_PLAN_TOOL,
		label: "Guide Plan Topology",
		description:
			"Incrementally construct a nonlinear plan by adding sequence, parallel, choice, revision, and final topology. The server retains the graph and compiles it to a validated PlanFSM only on finalize.",
		promptSnippet: "Expand the retained plan frontier with explicit topology operations",
		promptGuidelines: [
			"Start once, then grow the open frontier with add_sequence, add_parallel, add_choice, connect, update_state, and add_final operations.",
			"Use add_sequence to define macro subgoals and their concrete dependencies (producer-consumer, verification, etc).",
			"Use add_parallel whenever sibling subgoals do not consume one another's artifacts or decisions.",
			"Use connect to create backward loops (e.g., from a verification state back to an implementation state) to handle failures and revisions robustly.",
			"Do not serialize the complete PlanFSM. Finalize only after every open frontier has a final, convergence, or revision path.",
		],
		parameters: PlanGuideCommandSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled) throw new Error("guide_plan is only available while plan mode is active.");
			const result = applyPlanGuideCommand(planGuideDraft, params);
			planGuideDraft = result.draft;
			if (params.operation === "finalize" && result.errors.length > 0) {
				persistState();
				return {
					content: [
						{
							type: "text",
							text: `Plan guide is not executable:\n${result.errors.map((error) => `- ${error}`).join("\n")}\n\n${formatPlanGuideStatus(planGuideDraft)}`,
						},
					],
					details: { accepted: false, errors: result.errors, status: result.status },
				};
			}
			if (result.machine) {
				const fsm = new PlanFSM(result.machine);
				machineDefinition = fsm.machine;
				runtimeSnapshot = fsm.snapshot;
				planSubmittedThisRun = true;
			}
			updateStatus(ctx);
			persistState();
			if (!result.machine) {
				return {
					content: [{ type: "text", text: formatPlanGuideStatus(planGuideDraft) }],
					details: { accepted: false, status: result.status },
				};
			}
			popupPlanGraph(machineDefinition!).catch(() => {});
			return {
				content: [{ type: "text", text: `PlanFSM accepted.\n\n${formatPlanMachine(machineDefinition!)}` }],
				details: { machine: machineDefinition, snapshot: runtimeSnapshot },
			};
		},
	});

	pi.registerTool({
		name: TRANSITION_PLAN_TOOL,
		label: "Advance PlanFSM",
		description:
			"Advance the executing PlanFSM through an enabled transition. Use the exact event and optional source state shown in the execution context.",
		promptSnippet: "Advance active PlanFSM states with explicit events",
		promptGuidelines: [
			"During plan execution, call plan_transition after satisfying an active state's acceptance criteria.",
			"Use FAILURE, retry, or fallback transitions when criteria are not met.",
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
				evidence: params.rationale,
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
					evidence: params.rationale,
					snapshot: runtimeSnapshot,
				},
			};
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle PlanFSM mode (read-only exploration)",
		handler: async (_args, ctx) => await togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show the current PlanFSM and runtime state",
		handler: async (_args, ctx) => {
			if (!machineDefinition || !runtimeSnapshot) {
				ctx.ui.notify("No PlanFSM. Create one with /plan.", "info");
				return;
			}
			popupPlanGraph(machineDefinition!).catch(() => {});
			ctx.ui.notify(
				`${formatPlanRuntime(machineDefinition, runtimeSnapshot)}\n\n${formatPlanMachine(machineDefinition)}`,
				"info",
			);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle PlanFSM mode",
		handler: async (ctx) => await togglePlanMode(ctx),
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
Build an executable nonlinear guide with ${GUIDE_PLAN_TOOL}. The guide is retained server-side; never serialize a complete PlanFSM.

Current guide:
${formatPlanGuideStatus(planGuideDraft)}

Planning procedure:
${
	grillBeforePlanning
		? `0. Inspect and grill the user before committing topology.
   - First, resolve repository facts with read-only tools.
   - Second, you MUST use the questionnaire tool to grill the user and clarify any unresolved requirements or design decisions BEFORE proceeding with the plan topology.
   - CRITICAL: When using the questionnaire tool, you MUST ask exactly ONE question at a time (pass only one item in the questions array). Wait for the user's response before asking the next question.
   - Represent unresolved material decisions with add_choice.
   - Continue expanding every independent frontier that does not depend on the unresolved choice.

`
		: ""
}1. Establish the goal and boundaries.
   - Restate the complete user outcome in goal without shrinking its scope.
   - Identify repository rules, user constraints, named deliverables, tests, and runtime behavior required to prove completion.
   - Resolve important unknowns through read-only inspection. Ask the user only when a choice materially changes the result and cannot be discovered.

2. Draft the topology with ${GUIDE_PLAN_TOOL}.system before proposing implementation.
   - Locate relevant entry points, data flow, public contracts, tests, configuration, and error handling.
   - Search for existing functions, libraries, helpers, and abstractions that already provide each needed capability.
   - Put reuse and contract checks in state instructions and acceptanceCriteria. Do not create duplicate implementation states when an existing capability can be reused or extended.
   - Record assumptions as context.variables when a later guard or choice depends on them.

3. Decompose top-down.
   - Use abstraction levels goal, system, component, implementation, and verification.
   - parentId expresses conceptual ownership or decomposition. It does not create an execution dependency; transitions do that.
   - Each executable action state must have one bounded responsibility, an explicit role, a concrete instruction, measurable acceptanceCriteria, and an errorPolicy.
   - Keep states large enough to represent meaningful outcomes.

4. Build the dependency graph before choosing an order.
   - For every pair of action states, ask whether one consumes an artifact, decision, contract, or verified result produced by the other.
   - Add a serial transition only for a real data, control, resource-conflict, or user-decision dependency.
   - States sharing a predecessor with no dependency on one another are parallel candidates. Activate them together from a fork state with one multi-target transition.
   - Synchronize parallel branches with a multi-source transition into a join state before shared verification or integration.
   - File proximity or planning convenience alone does not justify serialization.
   - Set parallelism.strategy to parallel when any independent group exists. List each branch-entry group in independentStateGroups and explain remaining dependencies in rationale.
   - Set strategy to sequential only when every action is dependency-constrained; rationale must name those concrete predecessor relationships.

5. Choose state kinds by runtime meaning.
   - action: work that produces independently verifiable outcomes.
   - choice: a decision point with at least two guarded outgoing transitions. Guards should be mutually understandable and priorities deterministic.
   - fork: structural state whose outgoing transition activates multiple branch-entry states at once.
   - join: structural convergence reached by a transition whose from array contains every required branch-completion state.
   - checkpoint: structural marker that records one independently completed parallel branch.
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
   - acceptanceCriteria must name observable outcomes such as exact tests, type checks, runtime probes, changed contracts, or inspected artifacts.
   - Put shared integration verification after joins. Keep branch-local verification inside its branch when it does not depend on other branches.
   - A success transition is valid only after its source acceptanceCriteria can be supported.

10. Audit the complete machine before submission.
   - Check IDs and references, reachability, final outcomes, parent hierarchy, guard variables, error policies, loop bounds, fork targets, join sources, and transition limits.
   - Look for accidental linear chains. Convert independent siblings into fork/join branches.
   - Confirm the machine still covers the user's full goal and every named deliverable.

Guide protocol:
- Call start once, then expand the open frontier with topology operations.
- Use add_parallel for independent sibling outcomes and add_sequence only for concrete dependencies.
- Use add_choice for dynamic or user-dependent routes instead of silently selecting a branch.
- Treat action nodes as required postconditions. Existing code may satisfy one after verification; do not encode needless rewrites.
- Add verification, convergence, revision, and final paths before finalize.
- Repair only the affected topology operation when finalize reports an error. Never resend the graph.

Keep built-in write tools disabled throughout planning.`,
					display: false,
				},
			};
		}

		if (executionMode && machineDefinition && runtimeSnapshot) {
			return {
				message: {
					customType: "plan-execution-context",
					content: executionContext(),
					display: false,
				},
			};
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (executionMode && runtimeSnapshot?.status === "running") {
			executionRunTransitionCount = runtimeSnapshot.transitionCount;
			return;
		}
		if (!planModeEnabled || machineDefinition) return;
		planAgentRunning = true;
		updateStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		planAgentRunning = false;
		updateStatus(ctx);
		if (executionRunTransitionCount !== undefined) {
			const progressed =
				(runtimeSnapshot?.transitionCount ?? executionRunTransitionCount) > executionRunTransitionCount;
			executionRunTransitionCount = undefined;
			if (!executionMode || runtimeSnapshot?.status !== "running") return;
			noProgressRuns = progressed ? 0 : noProgressRuns + 1;
			if (noProgressRuns >= 2) {
				blockExecution(ctx, "The execution agent ended twice without advancing any active PlanFSM state.");
				return;
			}
			executionContinuationPending = true;
			return;
		}
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
			enableExecutionTools();
			runtimeSnapshot = fsm.start();
			planModeEnabled = false;
			executionMode = true;
			updateStatus(ctx);
			persistState();
			executionKickoffPending = true;
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

	pi.on("agent_settled", async () => {
		if (
			!executionMode ||
			runtimeSnapshot?.status !== "running" ||
			(!executionKickoffPending && !executionContinuationPending)
		) {
			return;
		}
		const kickoff = executionKickoffPending;
		executionKickoffPending = false;
		executionContinuationPending = false;
		if (kickoff && machineDefinition) {
			pi.sendMessage({
				customType: "plan-machine",
				content: formatPlanMachine(machineDefinition),
				display: true,
			});
		}
		pi.sendMessage(
			{
				customType: "plan-mode-execute",
				content: kickoff ? "Begin the ready PlanFSM frontier." : "Continue the ready PlanFSM frontier.",
				display: true,
			},
			{ triggerTurn: true },
		);
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
			grillBeforePlanning = entry.data.grillBeforePlanning ?? false;
			toolsBeforePlanMode = entry.data.toolsBeforePlanMode;
			planGuideDraft = entry.data.draft ?? createPlanGuideDraft();
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
