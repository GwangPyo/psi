import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "../../config.ts";

const PLAN_SYSTEM_PROMPT_FILENAME = "prompts/system-prompt.md";
const EXECUTION_SYSTEM_PROMPT_FILENAME = "prompts/execution-system-prompt.md";
const SCOUT_PROMPT_FILENAME = "prompts/scout-prompt.md";

function loadSystemPromptTemplate(filename: string): string {
	const packageDir = getPackageDir();
	const candidates = [
		join(packageDir, "src", "extensions", "plan", filename),
		join(packageDir, "dist", "extensions", "plan", filename),
		join(packageDir, "plan", filename),
	];
	const promptPath = candidates.find((candidate) => existsSync(candidate));
	if (!promptPath) {
		throw new Error(`Bundled plan system prompt "${filename}" was not found.`);
	}
	return readFileSync(promptPath, "utf8").trim();
}

const PLAN_SYSTEM_PROMPT_TEMPLATE = loadSystemPromptTemplate(PLAN_SYSTEM_PROMPT_FILENAME);
const EXECUTION_SYSTEM_PROMPT_TEMPLATE = loadSystemPromptTemplate(EXECUTION_SYSTEM_PROMPT_FILENAME);
const SCOUT_PROMPT_TEMPLATE = loadSystemPromptTemplate(SCOUT_PROMPT_FILENAME);

export interface BuildPlanSystemPromptOptions {
	guideToolName: string;
	grillToolName: string;
	finishGrillToolName: string;
	guideStatus: string;
	grillBeforePlanning: boolean;
	grillCompleted: boolean;
}

export function buildPlanSystemPrompt(options: BuildPlanSystemPromptOptions): string {
	const grillInstructions =
		options.grillBeforePlanning && !options.grillCompleted
			? `You are in a mandatory grill session and topology is locked. Resolve repository facts with read-only tools. Call \`${options.grillToolName}\` to ask exactly one material question at a time, wait for each answer, and continue through every unresolved decision branch. When you deliberately judge that all material decisions are resolved—or the user explicitly asks to finish the grill—call \`${options.finishGrillToolName}\`. Do not call \`${options.guideToolName}\` before that.`
			: options.grillBeforePlanning
				? `The mandatory grill is complete. Use all answers as planning constraints and proceed with \`${options.guideToolName}\`.`
				: `Resolve repository facts with read-only tools. Ask the user only when an undiscoverable choice would materially change the result.`;

	return PLAN_SYSTEM_PROMPT_TEMPLATE.replaceAll("{{GUIDE_TOOL}}", options.guideToolName)
		.replaceAll("{{GUIDE_STATUS}}", options.guideStatus)
		.replaceAll("{{DISCOVERY_POLICY}}", grillInstructions);
}

export interface BuildExecutionSystemPromptOptions {
	transitionToolName: string;
	runtime: string;
	activeStateInstructions: string;
	enabledTransitions: string;
}

export function buildExecutionSystemPrompt(options: BuildExecutionSystemPromptOptions): string {
	return EXECUTION_SYSTEM_PROMPT_TEMPLATE.replaceAll("{{TRANSITION_TOOL}}", options.transitionToolName)
		.replaceAll("{{PLAN_RUNTIME}}", options.runtime)
		.replaceAll("{{ACTIVE_STATE_INSTRUCTIONS}}", options.activeStateInstructions)
		.replaceAll("{{ENABLED_TRANSITIONS}}", options.enabledTransitions);
}

export function buildScoutSystemPrompt(prompt: string, artifactId: string, finishToolName: string): string {
	return SCOUT_PROMPT_TEMPLATE.replaceAll("{{PROMPT}}", prompt)
		.replaceAll("{{ARTIFACT_ID}}", artifactId)
		.replaceAll("{{FINISH_TOOL}}", finishToolName);
}
