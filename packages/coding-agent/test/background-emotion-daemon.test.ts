import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { BackgroundEmotionDaemon } from "../src/core/background-emotion-daemon.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { classifyNegativeSentiment, sentimentToolChoice } from "../src/extensions/dspy-features/sentiment/index.ts";

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("negative sentiment classification", () => {
	it("forces the schema tool and reads the boolean out of the tool call", async () => {
		let received: { context: Context; toolChoice: unknown } | undefined;
		const complete = vi.fn(async (context: Context, toolChoice: unknown) => {
			received = { context, toolChoice };
			return assistantMessage([
				{ type: "toolCall", id: "1", name: "report_negative_reaction", arguments: { negative_reaction: true } },
			]);
		});

		await expect(
			classifyNegativeSentiment(complete, "anthropic-messages", "Previous response", "This is unacceptable."),
		).resolves.toBe(true);

		expect(received?.toolChoice).toBe("any");
		expect(received?.context.tools).toHaveLength(1);
		expect(received?.context.tools?.[0]?.parameters).toMatchObject({
			type: "object",
			properties: { negative_reaction: { type: "boolean" } },
			additionalProperties: false,
		});
	});

	it("discards a text-only answer instead of parsing prose", async () => {
		const complete = vi.fn(async () =>
			assistantMessage([{ type: "text", text: "The user seems frustrated, so this is true." }]),
		);

		await expect(
			classifyNegativeSentiment(complete, "anthropic-messages", "Previous response", "This is unacceptable."),
		).resolves.toBe(false);
	});

	it("discards tool arguments that do not match the schema", async () => {
		const complete = vi.fn(async () =>
			assistantMessage([
				{ type: "toolCall", id: "1", name: "report_negative_reaction", arguments: { negative_reaction: "true" } },
			]),
		);

		await expect(
			classifyNegativeSentiment(complete, "anthropic-messages", "Previous response", "This is unacceptable."),
		).resolves.toBe(false);
	});

	it("maps each API family to a tool choice that forces the single tool", () => {
		expect(sentimentToolChoice("anthropic-messages")).toBe("any");
		expect(sentimentToolChoice("google-generative-ai")).toBe("any");
		expect(sentimentToolChoice("openai-completions")).toBe("required");
		expect(sentimentToolChoice("openai-responses")).toBe("required");
		expect(sentimentToolChoice("azure-openai-responses")).toBeUndefined();
	});
});

describe("BackgroundEmotionDaemon", () => {
	function createDaemon() {
		const sendCustomMessage = vi.fn();
		const getSubagentDefaultModel = vi.fn(() => "faux/subagent");
		const daemon = new BackgroundEmotionDaemon(
			{
				messages: [{ role: "assistant", content: [{ type: "text", text: "Previous response" }] }],
				subscribe: vi.fn(() => () => {}),
				sendCustomMessage,
			} as unknown as AgentSession,
			{ getSubagentDefaultModel } as unknown as SettingsManager,
			{} as ModelRuntime,
		);
		return { daemon, sendCustomMessage, getSubagentDefaultModel };
	}

	it("records negative sentiment as background context without emitting a message", async () => {
		const { daemon, sendCustomMessage, getSubagentDefaultModel } = createDaemon();
		const analyzeEmotion = vi.spyOn(daemon, "analyzeEmotionInBackground").mockResolvedValue(true);

		await expect(daemon.analyzeSentiment("This is unacceptable.")).resolves.toBe(true);

		expect(analyzeEmotion).toHaveBeenCalledWith("This is unacceptable.", "Previous response");
		expect(daemon.backgroundRunningContext).toContain("Negative sentiment detected");
		expect(getSubagentDefaultModel).not.toHaveBeenCalled();
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});

	it("records the negative verdict for a non-negative reply too", async () => {
		const { daemon } = createDaemon();
		vi.spyOn(daemon, "analyzeEmotionInBackground").mockResolvedValue(false);

		await expect(daemon.analyzeSentiment("Thanks, that worked.")).resolves.toBe(false);

		expect(daemon.backgroundRunningContext).toContain("No negative sentiment");
	});
});
