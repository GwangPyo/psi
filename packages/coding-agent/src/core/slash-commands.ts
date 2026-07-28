import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const EXTENSION_BACKED_BUILTIN_SLASH_COMMANDS = new Set(["adversarial_discussion"]);

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{
		name: "subagent-model",
		description: "Select the default model used by subagents",
		argumentHint: "[provider/model|status|clear]",
	},
	{
		name: "background-agent-model",
		description: "Select the default model used by background agents",
		argumentHint: "[provider/model|status|clear]",
	},
	{
		name: "manage_extension",
		description: "Add, remove, list, search, or inspect extension packages",
		argumentHint: "<add|remove|list|search|status> [source] [--local]",
	},
	{
		name: "broadcast",
		description: "Send a message to currently active agents (main or subagents)",
		argumentHint: "<msg>",
	},
	{
		name: "adversarial_discussion",
		description: "Run an adversarial discussion between multiple agents",
		argumentHint: "[goal]",
	},
	{ name: "emotion", description: "Show current background emotion context" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "usage", description: "Show remaining provider quota and recent usage" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "context", description: "Export session context (agy style) to a JSON file" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
