import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "../../config.ts";

const PLAN_SYSTEM_PROMPT_FILENAME = "system-prompt.md";
const EXECUTION_SYSTEM_PROMPT_FILENAME = "execution-system-prompt.md";

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

export interface BuildPlanSystemPromptOptions {
	guideToolName: string;
	grillToolName: string;
	guideStatus: string;
	grillBeforePlanning: boolean;
	grillCompleted: boolean;
}

export function buildPlanSystemPrompt(options: BuildPlanSystemPromptOptions): string {
	const grillInstructions =
		options.grillBeforePlanning && !options.grillCompleted
			? `Grill mode is mandatory and topology is locked. Resolve repository facts with read-only tools, then call \`${options.grillToolName}\` with exactly one material question whose answer cannot be discovered. Wait for the answer before calling \`${options.guideToolName}\`.`
			: options.grillBeforePlanning
				? `The mandatory grill was completed. Use its answer as a planning constraint. Ask another user question only if a new, undiscoverable choice would materially change the result.`
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
