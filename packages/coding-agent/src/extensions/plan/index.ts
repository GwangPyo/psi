/**
 * Plan Mode Extension
 *
 * Read-only exploration produces a validated PlanFSM. Execution advances the
 * persisted machine through explicit, structured transition tool calls.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Component, HBox, Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { type AnimatedStatus, startAnimatedStatus } from "../animated-status.ts";
import { swManager } from "../structured-writing/index.ts";
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
import { buildExecutionSystemPrompt, buildPlanSystemPrompt, buildScoutSystemPrompt } from "./prompt.ts";
import { PlanGraphComponent } from "./tui-graph.ts";
import { isSafeCommand } from "./utils.ts";

const GUIDE_PLAN_TOOL = "guide_plan";
const PLAN_GRILL_TOOL = "plan_grill";
const TRANSITION_PLAN_TOOL = "plan_transition";
const PLAN_DRAFTING_WIDGET = "plan-drafting";
const SCOUT_TOOL = "scout";
const SCOUT_RESULT_TOOL = "read_scout_result";
const SCOUT_FINISH_TOOL = "finish_scout";
const SCOUT_ARTIFACT_DIRECTORY = ".pi/scout-results";
const SCOUT_TIMEOUT_MS = 3 * 60 * 1000;
const PLAN_MODE_TOOLS = [SCOUT_TOOL, SCOUT_RESULT_TOOL, PLAN_GRILL_TOOL, GUIDE_PLAN_TOOL];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>([
	"edit",
	"write",
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	TRANSITION_PLAN_TOOL,
]);
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

interface ScoutArtifact {
	version: 1;
	artifactId: string;
	createdAt: string;
	model: string;
	input: {
		prompt: string;
	};
	output: {
		status: "running" | "completed" | "timed_out" | "cancelled" | "failed";
		text?: string;
		error?: string;
	};
}

class ScoutTimedOutError extends Error {
	constructor() {
		super("Scout exceeded its 3-minute limit");
	}
}

class ScoutCancelledError extends Error {
	constructor() {
		super("Scout cancelled");
	}
}

function scoutArtifactPath(cwd: string, artifactId: string): string {
	return resolve(cwd, SCOUT_ARTIFACT_DIRECTORY, `${artifactId}.json`);
}

async function writeScoutArtifact(cwd: string, artifact: ScoutArtifact): Promise<void> {
	await mkdir(resolve(cwd, SCOUT_ARTIFACT_DIRECTORY), { recursive: true });
	await writeFile(scoutArtifactPath(cwd, artifact.artifactId), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
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

	let planMessageCountAtStart = 0;
	let lastSummaryMessageCount = 0;
	let backgroundSummaries: string[] = [];
	let backgroundAgent: ReturnType<typeof pi.spawnAgent> | undefined;
	let isBackgroundSummarizing = false;
	const activeScoutArtifacts = new Map<string, ScoutArtifact>();

	function initBackgroundAgent(ctx: ExtensionContext) {
		if (backgroundAgent) return;
		const bgModelRef = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted ? ctx.isProjectTrusted() : true,
		}).getBackgroundAgentDefaultModel();
		let bgModel = ctx.model;
		if (bgModelRef) {
			const [provider, id] = bgModelRef.split("/");
			bgModel = ctx.modelRegistry.find(provider, id) ?? ctx.model;
		}
		if (!bgModel) return;

		backgroundAgent = pi.spawnAgent({
			model: bgModel,
			systemPrompt:
				"You are a background agent in Plan Mode. Your task is to use grep and read tools to investigate the codebase alongside the Main Agent's progress and provide brief, incremental summaries of structural findings. Maintain your context between requests. Do NOT propose plans. Just summarize the current codebase state.",
			toolNames: ["bash", "grep", "read", "find", "ls"],
		});
	}

	function disposeBackgroundAgent() {
		if (backgroundAgent) {
			backgroundAgent.dispose();
			backgroundAgent = undefined;
		}
	}

	async function runBackgroundSummary(ctx: ExtensionContext) {
		if (isBackgroundSummarizing || !backgroundAgent) return;
		isBackgroundSummarizing = true;

		try {
			ctx.ui.notify("Background agent is grepping and summarizing context...", "info");
			const previousSummary =
				backgroundSummaries.length > 0 ? backgroundSummaries[backgroundSummaries.length - 1] : "";

			const prompt =
				previousSummary === ""
					? "Please investigate the codebase using tools and provide a summary of the current structure. CRITICAL: Your final response MUST be a SINGLE plain-text summary under 200 characters. Do NOT use markdown."
					: `10 more turns have passed. Please investigate any newly relevant codebase structures and RE-SUMMARIZE the codebase state into a SINGLE updated summary.\n\nPrevious summary:\n${previousSummary}\n\nCRITICAL: You must completely rewrite and replace the old summary. Provide ONLY the new plain-text summary under 200 characters. Do NOT use markdown.`;

			let summary = await backgroundAgent.prompt(prompt);

			const stripFormatting = (text: string) =>
				text
					.replace(/```[\s\S]*?```/g, "")
					.replace(/(\*\*|__)(.*?)\1/g, "$2")
					.replace(/(\*|_)(.*?)\1/g, "$2")
					.replace(/`(.*?)`/g, "$1")
					.replace(/\[(.*?)\]\(.*?\)/g, "$1")
					.replace(/#+\s+(.*)/g, "$1")
					.replace(/>\s+(.*)/g, "$1")
					.replace(/^[-*+]\s+/gm, "")
					.replace(/\n+/g, " ")
					.trim();

			summary = stripFormatting(summary);

			if (summary.length > 250) {
				const retryPrompt =
					"Your previous summary was too long. Please RE-SUMMARIZE it to be strictly under 200 characters, using ONLY plain text without markdown.";
				summary = stripFormatting(await backgroundAgent.prompt(retryPrompt));
			}

			if (summary.length > 200) {
				const match = summary.substring(0, 197).match(/.*[.?!]/);
				if (match) {
					summary = match[0];
				} else {
					const lastSpace = summary.lastIndexOf(" ", 197);
					summary = `${lastSpace > 0 ? summary.substring(0, lastSpace) : summary.substring(0, 197)}...`;
				}
			}

			backgroundSummaries = [summary];

			ctx.ui.notify("Background summary updated.", "info");
			if (planLayoutWidget) {
				const leftText =
					machineDefinition && runtimeSnapshot
						? formatPlanWidget(machineDefinition, runtimeSnapshot).join("\n")
						: "";
				planLayoutWidget.update(leftText, formatPlanProgressText());
			}
		} catch (error) {
			ctx.ui.notify(`Background summarization failed: ${error}`, "error");
		} finally {
			isBackgroundSummarizing = false;
		}
	}

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
				lines.push(
					`▶ [${planGuideDraft.pendingReview.dimension} review] ${planGuideDraft.pendingReview.assessment}`,
				);
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

		const resultLines: string[] = [];
		if (lines.length > 10) {
			resultLines.push("... (earlier progress truncated)");
			resultLines.push(...lines.slice(-9));
		} else {
			resultLines.push(...lines);
		}

		if (backgroundSummaries && backgroundSummaries.length > 0) {
			resultLines.push("");
			resultLines.push("--- Latest Codebase Summary ---");
			const latestSummary = backgroundSummaries[backgroundSummaries.length - 1];
			resultLines.push(...latestSummary.split("\n"));
		}

		return resultLines.join("\n");
	}

	class PlanLayoutWidget implements Component {
		private hbox: HBox;
		private leftText: Text;
		private rightText: Text;
		private cachedHeight = 15;

		constructor() {
			this.leftText = new Text("", 1, 0);
			this.rightText = new Text("", 1, 0);
			this.hbox = new HBox(this.leftText, this.rightText, 0.5, 4);
		}

		update(left: string, right: string) {
			this.leftText.setText(left);
			this.rightText.setText(right);
			this.hbox.invalidate();
		}

		render(width: number): string[] {
			const lines = this.hbox.render(width);
			this.cachedHeight = Math.max(this.cachedHeight, lines.length);
			while (lines.length < this.cachedHeight) {
				lines.push("");
			}
			return lines;
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
			ctx.ui.setWidget(
				"plan-layout",
				(_tui, _thm) => {
					const widget = getPlanLayoutWidget();
					widget.update(
						formatPlanWidget(machineDefinition!, runtimeSnapshot!).join("\n"),
						formatPlanProgressText(),
					);
					return widget;
				},
				{ placement: "aboveEditor" },
			);
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
							ctx.ui.setWidget(
								"plan-layout",
								(_tui, _thm) => {
									const widget = getPlanLayoutWidget();
									widget.update(text || "", formatPlanProgressText());
									return widget;
								},
								{ placement: "aboveEditor" },
							);
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
			ctx.ui.setWidget(
				"plan-layout",
				(_tui, _thm) => {
					const leftText =
						machineDefinition && runtimeSnapshot
							? formatPlanWidget(machineDefinition, runtimeSnapshot).join("\n")
							: "";
					const widget = getPlanLayoutWidget();
					widget.update(leftText, formatPlanProgressText());
					return widget;
				},
				{ placement: "aboveEditor" },
			);
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
			grillCompleted,
			machine: machineDefinition,
			snapshot: runtimeSnapshot,
			draft: planGuideDraft,
			toolsBeforePlanMode,
		});
	}

	function clearPlan(): void {
		stopDraftingStatus();
		planLayoutWidget = undefined;
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
		planMessageCountAtStart = 0;
		lastSummaryMessageCount = 0;
		backgroundSummaries = [];
		disposeBackgroundAgent();
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		if (planModeEnabled || executionMode || machineDefinition) {
			planModeEnabled = false;
			executionMode = false;
			grillBeforePlanning = false;
			clearPlan();
			restoreNormalModeTools();
			ctx.ui.notify("Plan disabled and cleared. Full access restored.");
		} else {
			grillBeforePlanning = ctx.hasUI
				? await ctx.ui.confirm("Grill you?", "Inspect the implementation before making the plan.")
				: false;
			planModeEnabled = true;
			swManager.enable();
			executionMode = false;
			clearPlan();
			planMessageCountAtStart = ctx.sessionManager.buildSessionContext().messages.length;
			initBackgroundAgent(ctx);
			void runBackgroundSummary(ctx);
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
			if (!planModeEnabled) {
				throw new Error("plan_grill is only available in plan mode.");
			}
			if (!grillBeforePlanning || grillCompleted) {
				return {
					content: [
						{
							type: "text",
							text: "The grill is already completed or was skipped. Please proceed with guide_plan.",
						},
					],
					details: { completed: true },
				};
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

	pi.registerTool({
		name: SCOUT_FINISH_TOOL,
		label: "Finish Scout",
		description: "Finish an active scout early and persist its findings in the scout JSON artifact.",
		parameters: Type.Object({
			artifactId: Type.String({
				pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
				description: "Artifact ID supplied in the scout system prompt",
			}),
			summary: Type.String({ minLength: 1, description: "Concise evidence-backed findings for the main agent" }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const artifact = activeScoutArtifacts.get(params.artifactId);
			if (!artifact || artifact.output.status !== "running") {
				throw new Error(`No running scout exists for artifact ${params.artifactId}.`);
			}
			artifact.output = { status: "completed", text: params.summary };
			await writeScoutArtifact(ctx.cwd, artifact);
			return {
				content: [{ type: "text", text: "Scout findings saved. Ending scout." }],
				details: { artifactId: artifact.artifactId },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: SCOUT_TOOL,
		label: "Scout Information",
		description:
			"Launch a lightweight scout to investigate the codebase. The request and result are saved as a JSON artifact that must be read with read_scout_result.",
		promptSnippet: "Use the scout tool to gather information instead of reading directly",
		promptGuidelines: [
			"Since you do not have read tools during planning, call the scout tool when you need information about the codebase.",
			"Provide a clear research prompt to the scout, detailing exactly what you want it to look for.",
			"After scout returns an artifact ID, call read_scout_result and use the JSON content as the evidence for your plan.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Instructions for the scout agent on what to investigate." }),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scoutModelReference = SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted ? ctx.isProjectTrusted() : true,
			}).getBackgroundAgentDefaultModel();
			let scoutModel = ctx.model;
			if (scoutModelReference) {
				const [provider, id] = scoutModelReference.split("/");
				scoutModel = ctx.modelRegistry.find(provider, id) ?? ctx.model;
			}
			if (!scoutModel) {
				throw new Error("No model available for the scout agent.");
			}
			ctx.ui.notify("Scout agent is gathering information...", "info");
			const artifactId = randomUUID();
			const artifact: ScoutArtifact = {
				version: 1,
				artifactId,
				createdAt: new Date().toISOString(),
				model: `${scoutModel.provider}/${scoutModel.id}`,
				input: { prompt: params.prompt },
				output: { status: "running" },
			};
			activeScoutArtifacts.set(artifactId, artifact);
			await writeScoutArtifact(ctx.cwd, artifact);
			let scout: ReturnType<typeof pi.spawnAgent> | undefined;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let removeAbortListener: (() => void) | undefined;
			try {
				scout = pi.spawnAgent({
					model: scoutModel,
					systemPrompt: buildScoutSystemPrompt(params.prompt, artifactId, SCOUT_FINISH_TOOL),
					toolNames: ["read", "bash", "grep", "find", "ls", SCOUT_FINISH_TOOL],
				});
				const timedOut = new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new ScoutTimedOutError()), SCOUT_TIMEOUT_MS);
				});
				const cancelled = new Promise<never>((_resolve, reject) => {
					if (!signal) return;
					const cancel = () => reject(new ScoutCancelledError());
					if (signal.aborted) {
						cancel();
						return;
					}
					signal.addEventListener("abort", cancel, { once: true });
					removeAbortListener = () => signal.removeEventListener("abort", cancel);
				});
				const text = await Promise.race([scout.prompt(params.prompt), timedOut, cancelled]);
				if (artifact.output.status === "running") {
					artifact.output = { status: "completed", text };
				}
			} catch (error) {
				if (artifact.output.status === "completed") {
					// finish_scout persisted the summary and terminated the child agent.
				} else if (error instanceof ScoutTimedOutError) {
					artifact.output = { status: "timed_out", error: error.message };
					void scout?.abort();
				} else if (error instanceof ScoutCancelledError || signal?.aborted) {
					artifact.output = { status: "cancelled", error: "Scout cancelled" };
					void scout?.abort();
				} else {
					artifact.output = {
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
					};
				}
			} finally {
				if (timeout) clearTimeout(timeout);
				removeAbortListener?.();
				scout?.dispose();
				await writeScoutArtifact(ctx.cwd, artifact);
				activeScoutArtifacts.delete(artifactId);
			}
			const artifactPath = `${SCOUT_ARTIFACT_DIRECTORY}/${artifactId}.json`;
			const status = artifact.output.status === "completed" ? "completed" : artifact.output.status;
			ctx.ui.notify(
				`Scout ${status}; result saved to ${artifactPath}.`,
				status === "completed" ? "info" : "warning",
			);
			return {
				content: [
					{
						type: "text",
						text: `Scout ${status}. Call ${SCOUT_RESULT_TOOL} with artifactId "${artifactId}" to read ${artifactPath}.`,
					},
				],
				details: { artifactId, artifactPath, status },
			};
		},
	});

	pi.registerTool({
		name: SCOUT_RESULT_TOOL,
		label: "Read Scout Result",
		description: "Read one JSON artifact written by the scout tool.",
		promptSnippet: "Read a completed scout JSON artifact before using its findings",
		parameters: Type.Object({
			artifactId: Type.String({
				pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
				description: "Artifact ID returned by scout",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const artifactPath = scoutArtifactPath(ctx.cwd, params.artifactId);
			const content = await readFile(artifactPath, "utf8");
			return {
				content: [{ type: "text", text: content }],
				details: {
					artifactId: params.artifactId,
					artifactPath: `${SCOUT_ARTIFACT_DIRECTORY}/${params.artifactId}.json`,
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
		const filtered = event.messages.filter((message) => {
			const customType = "customType" in message ? message.customType : undefined;
			if (customType === "plan-mode-context" && !planModeEnabled) return false;
			if (customType === "plan-execution-context" && !executionMode) return false;
			return true;
		});

		if (planModeEnabled && backgroundSummaries.length > 0) {
			filtered.push({
				role: "system",
				content: [{ type: "text", text: backgroundSummaries.join("\n\n") }],
				timestamp: Date.now(),
			} as any);
		}

		return { messages: filtered };
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

		if (planModeEnabled && backgroundAgent) {
			const currentMessagesLength = ctx.sessionManager.buildSessionContext().messages.length;
			const addedMessages = currentMessagesLength - planMessageCountAtStart;
			if (addedMessages >= lastSummaryMessageCount + 10) {
				lastSummaryMessageCount = addedMessages;
				void runBackgroundSummary(ctx);
			}
		}

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
