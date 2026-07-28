/**
 * Plan Mode Extension
 *
 * Read-only exploration produces a validated PlanFSM. Execution advances the
 * persisted machine through explicit, structured transition tool calls.
 */

import { Key, Text, HBox, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
	type PlanRuntimeSnapshot,
	type PlanTransition,
} from "./fsm/index.ts";
import {
	applyPlanGuideCommand,
	createPlanGuideDraft,
	formatPlanGuideGrounding,
	PlanGuideCommandSchema,
	type PlanGuideDraft,
	preparePlanGuideArguments,
} from "./guide.ts";
import { buildExecutionSystemPrompt, buildPlanSystemPrompt } from "./prompt.ts";
import { PlanGraphComponent } from "./tui-graph.ts";
import { isSafeCommand } from "./utils.ts";

const GUIDE_PLAN_TOOL = "guide_plan";
const PLAN_GRILL_TOOL = "plan_grill";
const TRANSITION_PLAN_TOOL = "plan_transition";
const PLAN_DRAFTING_WIDGET = "plan-drafting";
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", PLAN_GRILL_TOOL, GUIDE_PLAN_TOOL];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", TRANSITION_PLAN_TOOL]);
const PLAN_CONTROL_TOOLS = new Set<string>([PLAN_GRILL_TOOL, GUIDE_PLAN_TOOL, TRANSITION_PLAN_TOOL]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS, ...PLAN_CONTROL_TOOLS]);

const PlanGrillParameters = Type.Object({
	question: Type.String({
		minLength: 1,
		description: "One material question whose answer cannot be discovered from the repository",
	}),
	choices: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			minItems: 2,
			uniqueItems: true,
			description: "Optional concrete choices; omit when the user needs free-form input",
		}),
	),
});

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
	grillCompleted?: boolean;
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
	let grillCompleted = false;
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

	function formatPlanProgressText(): string {
		const lines: string[] = [];
		if (!machineDefinition) {
			if (planGuideDraft.reviews.length > 0) {
				for (const review of planGuideDraft.reviews) {
					lines.push(`▶ [${review.dimension} review] ${review.revisionSummary}`);
				}
			}
			if (planGuideDraft.pendingReview) {
				lines.push(`▶ [${planGuideDraft.pendingReview.dimension} review] ${planGuideDraft.pendingReview.assessment}`);
			}
		} else if (runtimeSnapshot) {
			for (const record of runtimeSnapshot.history) {
				const prefix = record.sourceStateId ? `▶ [${record.sourceStateId}]` : "▶";
				lines.push(`${prefix} ${record.event}${record.evidence ? ` - ${record.evidence}` : ""}`);
			}
			if (runtimeSnapshot.blockReason) {
				lines.push(`▶ Blocked: ${runtimeSnapshot.blockReason}`);
			}
		}
		
		if (lines.length === 0) {
			lines.push("▶ Waiting for agent progress...");
		}
		
		if (lines.length > 10) {
			return "... (earlier progress truncated)\n" + lines.slice(-9).join("\n");
		}
		return lines.join("\n");
	}

	class PlanLayoutWidget implements Component {
		private hbox: HBox;
		private leftText: Text;
		private rightText: Text;

		constructor() {
			this.leftText = new Text("", 1, 0);
			this.rightText = new Text("", 1, 0);
			this.hbox = new HBox(this.leftText, this.rightText, 0.4, 4);
		}

		update(left: string, right: string) {
			this.leftText.setText(left);
			this.rightText.setText(right);
			this.hbox.invalidate();
		}

		render(width: number): string[] {
			return this.hbox.render(width);
		}

		invalidate(): void {
			this.hbox.invalidate();
		}
	}

	let planLayoutWidget: PlanLayoutWidget | undefined;

	function getPlanLayoutWidget(): PlanLayoutWidget {
		if (!planLayoutWidget) {
			planLayoutWidget = new PlanLayoutWidget();
		}
		return planLayoutWidget;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && machineDefinition && runtimeSnapshot) {
			stopDraftingStatus();
			const completed = machineDefinition.states.filter(
				(state) => state.kind !== "final" && runtimeSnapshot?.completedStateIds.includes(state.id),
			).length;
			const total = machineDefinition.states.filter((state) => state.kind !== "final").length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `plan ${completed}/${total}`));
			ctx.ui.setWidget("plan-layout", (_tui, _thm) => {
				const widget = getPlanLayoutWidget();
				widget.update(formatPlanWidget(machineDefinition!, runtimeSnapshot!).join("\n"), formatPlanProgressText());
				return widget;
			}, { placement: "aboveEditor" });
			ctx.ui.setWidget(PLAN_DRAFTING_WIDGET, undefined);
			ctx.ui.setWidget("plan-todos", undefined);
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
						setStatus: (text) => {
							ctx.ui.setWidget("plan-layout", (_tui, _thm) => {
								const widget = getPlanLayoutWidget();
								widget.update(text || "", formatPlanProgressText());
								return widget;
							}, { placement: "aboveEditor" });
						},
						render: (frame, text) => `${ctx.ui.theme.fg("accent", frame)} ${ctx.ui.theme.fg("warning", text)}`,
					});
				}
				ctx.ui.setWidget("plan-todos", undefined);
				ctx.ui.setWidget(PLAN_DRAFTING_WIDGET, undefined);
				return;
			}

			stopDraftingStatus();
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", machineDefinition ? "plan ready" : "plan drafting"));
			ctx.ui.setWidget("plan-layout", (_tui, _thm) => {
				const leftText = machineDefinition && runtimeSnapshot ? formatPlanWidget(machineDefinition, runtimeSnapshot).join("\n") : "";
				const widget = getPlanLayoutWidget();
				widget.update(leftText, formatPlanProgressText());
				return widget;
			}, { placement: "aboveEditor" });
			ctx.ui.setWidget("plan-todos", undefined);
			ctx.ui.setWidget(PLAN_DRAFTING_WIDGET, undefined);
			return;
		}

		stopDraftingStatus();
		ctx.ui.setStatus("plan-mode", undefined);
		ctx.ui.setWidget("plan-layout", undefined);
		ctx.ui.setWidget("plan-todos", undefined);
		ctx.ui.setWidget(PLAN_DRAFTING_WIDGET, undefined);
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...withoutPlanControlTools(activeToolNames).filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS.filter((name) => name !== PLAN_GRILL_TOOL || (grillBeforePlanning && !grillCompleted)),
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
			grillCompleted,
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
		grillCompleted = !grillBeforePlanning;
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
		return buildExecutionSystemPrompt({
			transitionToolName: TRANSITION_PLAN_TOOL,
			runtime: formatPlanRuntime(machineDefinition, runtimeSnapshot),
			activeStateInstructions: formatActiveStateInstructions(machineDefinition, runtimeSnapshot),
			enabledTransitions: formatEnabledTransitions(getEnabledTransitions(fsm)),
		});
	}

	pi.registerFlag("plan", {
		description: "Start in PlanFSM mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_GRILL_TOOL,
		label: "Plan Grill",
		description:
			"Ask exactly one material planning question. When grill-before-planning is enabled, guide_plan remains blocked until the user answers this tool.",
		promptSnippet: "Resolve one undiscoverable material planning decision before drafting",
		promptGuidelines: [
			"Inspect the repository first and ask only a question whose answer materially changes the plan.",
			"Ask exactly one question per call.",
		],
		parameters: PlanGrillParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled || !grillBeforePlanning) {
				throw new Error("plan_grill is only available when grill-before-planning is active.");
			}
			if (!ctx.hasUI) throw new Error("plan_grill requires interactive UI.");

			const answer = params.choices
				? await ctx.ui.select(params.question, params.choices)
				: await ctx.ui.editor(params.question, "");
			if (!answer?.trim()) {
				return {
					content: [{ type: "text", text: "The grill question was cancelled or left unanswered." }],
					details: { completed: false },
				};
			}

			grillCompleted = true;
			enablePlanModeTools();
			persistState();
			ctx.ui.notify("Planning grill completed. Plan topology is now unlocked.", "info");
			return {
				content: [{ type: "text", text: `User answer: ${answer.trim()}` }],
				details: { completed: true, answer: answer.trim() },
			};
		},
	});

	pi.registerTool({
		name: GUIDE_PLAN_TOOL,
		label: "Guide Plan Topology",
		description:
			"Incrementally construct a nonlinear plan with one operation per call. The server retains the graph, so send only fields required by the selected operation. Refine an existing action with update_state and compile only with finalize.",
		promptSnippet: "Expand the retained plan frontier with explicit topology operations",
		promptGuidelines: [
			"Plan top-down from goal and system outcomes to component, implementation, and verification actions; use parentId for conceptual ownership and transitions for execution order.",
			"Start once, build dependency-correct topology, then review and revise it in strict what, how, why, when order followed by a final FSM dependency audit.",
			"Use add_parallel for independent siblings, add_sequence only for concrete dependencies, add_choice for guarded routes, and connect for convergence or bounded loops.",
			"Each review requires a subsequent state or topology change and exactly one matching revise operation.",
			"Finalize only after every frontier is closed, all question revisions are complete, and independent sibling tasks have validated fork/join topology.",
		],
		parameters: PlanGuideCommandSchema,
		prepareArguments: (input) => preparePlanGuideArguments(input, planGuideDraft.pendingReview?.dimension),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled) throw new Error("guide_plan is only available while plan mode is active.");
			if (grillBeforePlanning && !grillCompleted) {
				throw new Error(
					`Planning grill is required. Inspect the repository, call ${PLAN_GRILL_TOOL}, and wait for the user's answer before using ${GUIDE_PLAN_TOOL}.`,
				);
			}
			let result: ReturnType<typeof applyPlanGuideCommand>;
			try {
				result = applyPlanGuideCommand(planGuideDraft, params);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`${message}\n\n${formatPlanGuideGrounding(planGuideDraft)}`, { cause: error });
			}
			planGuideDraft = result.draft;
			if (params.operation === "finalize" && result.errors.length > 0) {
				persistState();
				return {
					content: [
						{
							type: "text",
							text: `Plan guide is not executable:\n${result.errors.map((error) => `- ${error}`).join("\n")}\n\n${formatPlanGuideGrounding(planGuideDraft)}`,
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
					content: [{ type: "text", text: formatPlanGuideGrounding(planGuideDraft) }],
					details: { accepted: true, status: result.status },
				};
			}
			return {
				content: [{ type: "text", text: `PlanFSM accepted.\n\n${formatPlanMachine(machineDefinition!)}` }],
				details: { machine: machineDefinition, snapshot: runtimeSnapshot },
			};
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						machine?: PlanMachineDefinition;
						snapshot?: PlanRuntimeSnapshot;
						errors?: string[];
				  }
				| undefined;
			if (details?.machine) {
				return new PlanGraphComponent(details.machine, theme, {
					expanded,
					snapshot: details.snapshot,
				});
			}
			const content = result.content[0];
			const text = content?.type === "text" ? content.text : "";
			return new Text(details?.errors ? theme.fg("error", text) : theme.fg("muted", text), 0, 0);
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

	pi.on("before_agent_start", async (event) => {
		if (planModeEnabled) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildPlanSystemPrompt({
					guideToolName: GUIDE_PLAN_TOOL,
					grillToolName: PLAN_GRILL_TOOL,
					guideStatus: formatPlanGuideGrounding(planGuideDraft),
					grillBeforePlanning,
					grillCompleted,
				})}`,
			};
		}

		if (executionMode && machineDefinition && runtimeSnapshot) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${executionContext()}`,
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
			grillCompleted = entry.data.grillCompleted ?? !grillBeforePlanning;
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
