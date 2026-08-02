import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { BackgroundEmotionDaemon } from "../src/core/background-emotion-daemon.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { classifyNegativeSentiment } from "../src/extensions/dspy-features/sentiment/index.ts";

describe("BackgroundEmotionDaemon", () => {
	it("classifies sentiment through the configured account completion", async () => {
		const complete = vi.fn(async () => "negative_reaction: true");

		await expect(classifyNegativeSentiment({ complete }, "Previous response", "This is unacceptable.")).resolves.toBe(
			true,
		);
		expect(complete).toHaveBeenCalledWith(expect.stringContaining("assistant_result: Previous response"));
	});

	it("does not emit an intention-analysis message after negative sentiment", async () => {
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
		const analyzeEmotion = vi.spyOn(daemon, "analyzeEmotionInBackground").mockResolvedValue(true);

		await expect(daemon.analyzeAndRunIntention("This is unacceptable.")).resolves.toBe(true);

		expect(analyzeEmotion).toHaveBeenCalledWith("This is unacceptable.", "Previous response");
		expect(getSubagentDefaultModel).not.toHaveBeenCalled();
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});
});
