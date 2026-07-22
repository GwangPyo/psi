import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		// First 2000 chars should be present
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should omit standalone tool success acknowledgements", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "edit",
				content: [{ type: "text", text: "Successfully replaced text in src/app.ts." }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tc2",
				toolName: "apply_patch",
				content: [{ type: "text", text: "Done!" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		expect(serializeConversation(messages)).toBe("");
	});

	it("should remove success noise lines while preserving meaningful output", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: [
					{
						type: "text",
						text: "Command completed successfully.\n42 tests passed\nProcess exited with code 0.",
					},
				],
				isError: false,
				timestamp: Date.now(),
			},
		];

		expect(serializeConversation(messages)).toBe("[Tool result]: 42 tests passed");
	});

	it("should filter tool success noise before truncating", () => {
		const meaningfulOutput = "y".repeat(1900);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "write",
				content: [
					{
						type: "text",
						text: `Successfully wrote ${"x".repeat(1000)}\n${meaningfulOutput}`,
					},
				],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${meaningfulOutput}`);
		expect(result).not.toContain("truncated");
	});

	it("should preserve error tool results verbatim", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: [{ type: "text", text: "Done!\nError: verification failed" }],
				isError: true,
				timestamp: Date.now(),
			},
		];

		expect(serializeConversation(messages)).toBe("[Tool result]: Done!\nError: verification failed");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
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
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
