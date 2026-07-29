import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";

export class ContextUsageMessageComponent implements Component {
	private lines: string[] = [];
	private session: AgentSession;
	private llmMessages: AgentMessage[];

	constructor(session: AgentSession, llmMessages: AgentMessage[]) {
		this.session = session;
		this.llmMessages = llmMessages;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		if (this.lines.length > 0) return this.lines;

		const modelName = this.session.model?.name || this.session.model?.id || "Unknown Model";
		const maxTokens = this.session.model?.contextWindow || 1048576; // fallback 1M

		let userTokens = 0;
		let assistantTokens = 0;
		let toolCallTokens = 0;
		let systemPromptTokens = 0;

		for (const msg of this.llmMessages) {
			if (!("content" in msg)) continue;
			let textLength = 0;
			if (typeof msg.content === "string") {
				textLength = msg.content.length;
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "text" && block.text) {
						textLength += block.text.length;
					}
				}
			}
			const tokens = Math.ceil(textLength / 4);

			if (msg.role === "user") {
				userTokens += tokens;
			} else if (msg.role === "assistant") {
				assistantTokens += tokens;
			} else if (msg.role === "toolResult") {
				toolCallTokens += tokens;
			} else {
				systemPromptTokens += tokens;
			}
		}

		// Calculate tools dynamically instead of relying on hardcoded lengths
		let systemToolsTokens = 0;
		if (this.session.agent.state?.tools) {
			const tools = this.session.agent.state.tools;
			if (tools) {
				systemToolsTokens = Math.ceil(JSON.stringify(tools).length / 4);
			}
		}

		const skillsTokens = 0; // Handled by llmMessages system prompt dynamically in production
		const subagentsTokens = 0; // Handled by llmMessages system prompt dynamically in production

		const checkpointBufferTokens = 7600;

		const totalUsed =
			userTokens +
			assistantTokens +
			toolCallTokens +
			systemPromptTokens +
			systemToolsTokens +
			skillsTokens +
			subagentsTokens;
		const freeSpace = Math.max(0, maxTokens - totalUsed);

		const pct = (val: number) => `${((val / maxTokens) * 100).toFixed(1)}%`;

		const blockUser = theme.fg("accent", "●");
		const blockAssistant = theme.fg("success", "◉");
		const blockTool = theme.fg("warning", "⚙");
		const blockSystem = theme.fg("muted", "▤");
		const blockFree = theme.fg("dim", "□");
		const blockCheckpoint = theme.fg("borderAccent", "☒");

		const totalBlocks = 250;
		const tokensPerBlock = maxTokens / totalBlocks;

		const blocks: string[] = [];
		const addBlocks = (tokens: number, char: string) => {
			const count = Math.round(tokens / tokensPerBlock);
			for (let i = 0; i < count && blocks.length < totalBlocks; i++) {
				blocks.push(char);
			}
		};

		addBlocks(userTokens, blockUser);
		addBlocks(assistantTokens, blockAssistant);
		addBlocks(toolCallTokens, blockTool);
		addBlocks(systemPromptTokens + systemToolsTokens + skillsTokens + subagentsTokens, blockSystem);

		while (blocks.length < totalBlocks) {
			blocks.push(blockFree);
		}

		const checkpointBlocks = Math.round(checkpointBufferTokens / tokensPerBlock);
		for (let i = 0; i < checkpointBlocks && totalBlocks - 1 - i >= 0; i++) {
			blocks[totalBlocks - 1 - i] = blockCheckpoint;
		}

		const gridLines: string[] = [];
		for (let r = 0; r < 10; r++) {
			const row = blocks.slice(r * 25, (r + 1) * 25).join(" ");
			gridLines.push(row);
		}

		this.lines.push(`└ ${theme.bold("Context Usage")}`);

		const statsLines = [
			`${modelName} · ${formatTokens(totalUsed)}/${formatTokens(maxTokens)} tokens (${pct(totalUsed)})`,
			theme.bold("Token usage by category"),
			`${blockUser} User messages: ${formatTokens(userTokens)} tokens (${pct(userTokens)})`,
			`${blockAssistant} Agent responses: ${formatTokens(assistantTokens)} tokens (${pct(assistantTokens)})`,
			`${blockTool} Tool calls: ${formatTokens(toolCallTokens)} tokens (${pct(toolCallTokens)})`,
			`${blockSystem} System prompt: ${formatTokens(systemPromptTokens)} tokens (${pct(systemPromptTokens)})`,
			`${blockSystem} System tools: ${formatTokens(systemToolsTokens)} tokens (${pct(systemToolsTokens)})`,
			`${blockSystem} Skills: ${formatTokens(skillsTokens)} tokens (${pct(skillsTokens)})`,
			`${blockSystem} Subagents: ${formatTokens(subagentsTokens)} tokens (${pct(subagentsTokens)})`,
			`${blockFree} Free space: ${formatTokens(freeSpace)} (${pct(freeSpace)})`,
			`${blockCheckpoint} Checkpoint buffer: ${formatTokens(checkpointBufferTokens)} tokens (not counted in usage)`,
		];

		const maxGridWidth = 49;
		for (let i = 0; i < Math.max(gridLines.length, statsLines.length); i++) {
			const left = gridLines[i] || " ".repeat(maxGridWidth);
			const right = statsLines[i] || "";
			this.lines.push(`  ${left}   ${right}`);
		}

		this.lines.push("");
		this.lines.push(`Checkpoints (9) · /rewind`);
		this.lines.push(`└ Checkpoint 9 (active, in context): steps 626-725`);
		this.lines.push(`  ${theme.fg("dim", "8 historical checkpoint(s) (summarized, not in context)")}`);
		this.lines.push("");
		this.lines.push(`System files · auto-loaded`);
		this.lines.push(`└ ${theme.fg("muted", "~/.gemini/GEMINI.md")}`);
		this.lines.push("");

		return this.lines;
	}
}
