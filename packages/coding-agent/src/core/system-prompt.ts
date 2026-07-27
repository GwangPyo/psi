/**
 * System prompt construction and project context loading
 */

import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface RuntimeToolPrompt {
	name: string;
	description?: string;
}

const RUNTIME_TOOLS_PATTERN = /\n?<available_tools>\n[\s\S]*?\n<\/available_tools>\n?/gu;
const LEGACY_TOOLS_PATTERN =
	/\n?Available tools:\n[\s\S]*?\n\nIn addition to the tools above, you may have access to other custom tools depending on the project\.\n?/u;

function escapeXml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Add the authoritative tool catalog for the current provider request. */
export function injectRuntimeTools(
	basePrompt: string,
	tools: RuntimeToolPrompt[],
	legacyToolGuidelines: string[] = [],
): string {
	let prompt = basePrompt.replace(RUNTIME_TOOLS_PATTERN, "\n").replace(LEGACY_TOOLS_PATTERN, "\n");
	for (const guideline of ["Use bash for file operations like ls, rg, find", ...legacyToolGuidelines]) {
		const line = `- ${guideline.trim()}`;
		prompt = prompt
			.split("\n")
			.filter((candidate) => candidate.trim() !== line)
			.join("\n");
	}
	const catalog =
		tools.length === 0
			? "(none)"
			: tools
					.map(({ name, description }) =>
						description ? `- ${escapeXml(name)}: ${escapeXml(description)}` : `- ${escapeXml(name)}`,
					)
					.join("\n");
	return `${prompt.trimEnd()}\n\n<available_tools>\nThis is the authoritative tool list for the current turn. Only these tools can be called; ignore older tool lists elsewhere in the prompt.\n${catalog}\n</available_tools>`;
}

/** Add guidance only after the model has selected a tool, for the following tool-result continuation. */
export function injectToolGuidance(basePrompt: string, toolName: string, guidelines: string[]): string {
	if (guidelines.length === 0) return basePrompt;
	return `${basePrompt.trimEnd()}\n\n<tool_guidance tool="${escapeXml(toolName)}">\n${guidelines.map((guideline) => `- ${escapeXml(guideline)}`).join("\n")}\n</tool_guidance>`;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Active tool names used while constructing tool-dependent static context. */
	selectedTools?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt. Runtime tool metadata is injected separately at the provider boundary. */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const hasRead = tools.includes("read");

	let prompt = `You help users by reading files, executing commands, editing code, and writing new files.
Focus on the essence of the request.
-- Distinguish between areas that require focused implementation and areas where existing code can simply be reused.
-- When a user uses phrases like 'for example...', a process of generalization is required.
--- When the user says, 'for example, Y instead of X,' focus deeper on the essence. Why did they say Y instead of X? You must undergo a sufficient generalization process to understand the underlying issues in the cases the user didn't explicitly mention. Fixating on the literal tokens 'not X but Y' and simply leaving a comment like 'Not X...' is the worst possible behavior.
--- Even when the user says 'for example, C,' you must not process only C. Deduce why the user said 'for example,' why C serves as a representative example, and what implicit problem situations might arise when it is generalized.
-- In short, while examples are important, focus on the essence of the context that prompted the example, rather than the example itself.
-- Applying a simple implementation is a good heuristic, but taking shortcuts to avoid the problems is bad.

-- The boundary between disciplined generalization and speculative refactoring is intent: generalize only enough to satisfy the requested outcome across structurally equivalent cases at the shared seam.
-- If a proposed change would still be acceptable when restated without the example, it preserves intent. If it only looks correct because it matches the example's literal structure, it misses the point.
-- Examples are evidence, topology is a tool, but intent is the standard.
-- Your role is not 'making the code run,' but 'solving the problem'

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files

Implementation discipline:
- Understand the request and trace the relevant existing flow before choosing a change.
- Use the first sufficient option: avoid building it, reuse repository code, use the standard library or native platform, use an already-installed dependency, then write the minimum new code.
- Fix root causes at the shared seam instead of patching one reported symptom when sibling paths have the same defect.
- Avoid speculative abstractions, dependencies, boilerplate, and files. Prefer deletion and straightforward code.
- A small diff is only good when it preserves input validation, data-loss prevention, security, accessibility, and every explicit requirement.
- For non-trivial behavior, leave the smallest runnable check that would fail if the behavior regresses`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
