/**
 * System prompt construction and project context loading
 */

import { readFileSync } from "node:fs";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

const DEFAULT_SYSTEM_PROMPT = readFileSync(
	new URL("./prompts/default-system-prompt.md", import.meta.url),
	"utf-8",
).trim();
const OPENAI_SYSTEM_PROMPT = readFileSync(
	new URL("./prompts/openai-system-prompt.md", import.meta.url),
	"utf-8",
).trim();
const GOOGLE_SYSTEM_PROMPT = readFileSync(
	new URL("./prompts/google-system-prompt.md", import.meta.url),
	"utf-8",
).trim();

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
	/** Provider type / ID (e.g., openai, google). */
	providerId?: string;
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

/**
 * Build the system prompt from the packaged Markdown default or a caller-supplied override.
 * Runtime tool metadata is injected separately at the provider boundary.
 */
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

	let prompt = customPrompt || DEFAULT_SYSTEM_PROMPT;

	if (options.providerId === "openai") {
		prompt += `\n\n${OPENAI_SYSTEM_PROMPT}`;
	} else if (options.providerId === "google") {
		prompt += `\n\n${GOOGLE_SYSTEM_PROMPT}`;
	}

	if (appendSection) {
		prompt += appendSection;
	}

	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const hasRead = tools.includes("read");
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
