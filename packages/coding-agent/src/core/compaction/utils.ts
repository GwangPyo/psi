/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "../../config.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/** Standalone success acknowledgements that do not add useful summarization context. */
const TOOL_RESULT_NOISE_PATTERNS = [
	/^\s*(?:ok|success(?:ful(?:ly)?)?|done|completed)[.!\s✓✔]*$/iu,
	/^\s*(?:command|operation|request|task|tool)\s+(?:completed|finished|succeeded)(?:\s+successfully)?[.!\s]*$/iu,
	/^\s*(?:process|command)\s+(?:exited|finished|completed)\s+with\s+(?:exit\s+)?code\s+0[.!\s]*$/iu,
	/^\s*(?:exit(?:\s+code)?|status)\s*[:=]\s*0[.!\s]*$/iu,
	/^\s*successfully\s+(?:replaced|wrote|saved|created|updated|deleted|removed|moved|copied|renamed|applied)\b.*$/iu,
	/^\s*(?:file|directory|patch|changes?)\b.*\b(?:created|written|saved|updated|deleted|removed|applied)\s+successfully[.!\s]*$/iu,
];

function filterToolResultNoise(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => !TOOL_RESULT_NOISE_PATTERNS.some((pattern) => pattern.test(line)))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content, "");
			const filteredContent = msg.isError ? content : filterToolResultNoise(content);
			if (filteredContent) {
				parts.push(`[Tool result]: ${truncateForSummary(filteredContent, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

let summarizationSystemPromptTemplate: string | undefined;

function getSummarizationSystemPromptTemplate(): string {
	if (summarizationSystemPromptTemplate !== undefined) return summarizationSystemPromptTemplate;
	
	const packageDir = getPackageDir();
	const filename = "summarization-system-prompt.md";
	const candidates = [
		join(packageDir, "src", "core", "compaction", filename),
		join(packageDir, "dist", "core", "compaction", filename),
		join(packageDir, "core", "compaction", filename),
	];
	const promptPath = candidates.find((candidate) => existsSync(candidate));
	if (!promptPath) {
		throw new Error(`Bundled system prompt "${filename}" was not found.`);
	}
	summarizationSystemPromptTemplate = readFileSync(promptPath, "utf8").trim();
	return summarizationSystemPromptTemplate;
}

export const SUMMARIZATION_SYSTEM_PROMPT = getSummarizationSystemPromptTemplate();
