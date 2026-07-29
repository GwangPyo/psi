import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistant(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" | "length"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("AgentSession.spawnAgent", () => {
	it("aborts active spawned agents when the session is cancelled", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let resolveChildStarted!: () => void;
		const childStarted = new Promise<void>((resolve) => {
			resolveChildStarted = resolve;
		});
		let childAborted = false;
		let childSystemPrompt = "";
		const parentAgent = new Agent({
			initialState: { model, systemPrompt: "parent prompt", tools: [], thinkingLevel: "high" },
			streamFn: (_model, context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = assistant([], "stop");
					stream.push({ type: "start", partial: message });
					if (context.systemPrompt?.includes("waiting child prompt")) {
						childSystemPrompt = context.systemPrompt;
						resolveChildStarted();
						options?.signal?.addEventListener(
							"abort",
							() => {
								childAborted = true;
								stream.push({ type: "error", reason: "aborted", error: message });
							},
							{ once: true },
						);
						return;
					}
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const authStorage = AuthStorage.inMemory();
		const session = new AgentSession({
			agent: parentAgent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});
		const spawned = session.spawnAgent({
			model,
			systemPrompt: "waiting child prompt",
		});

		try {
			const prompt = spawned.prompt("Work until cancelled");
			await childStarted;
			expect(childSystemPrompt).toContain("Ponytail");
			expect(childSystemPrompt).toContain("waiting child prompt");
			expect(session.hasRunningSpawnedAgents).toBe(true);

			await session.abort();

			expect(childAborted).toBe(true);
			await expect(prompt).rejects.toThrow("Spawned agent returned no text");
			expect(session.hasRunningSpawnedAgents).toBe(false);
		} finally {
			spawned.dispose();
			session.dispose();
		}
	});

	it("reuses registered tools in-process with an isolated transcript and system prompt", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "verified evidence" }],
			details: {},
		}));
		const seenSystemPrompts: string[] = [];
		const seenMessages: unknown[][] = [];
		const parentAgent = new Agent({
			initialState: { model, systemPrompt: "parent prompt", tools: [], thinkingLevel: "high" },
			streamFn: (_model, context) => {
				seenSystemPrompts.push(context.systemPrompt ?? "");
				seenMessages.push(context.messages);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const hasToolResult = context.messages.some((message) => message.role === "toolResult");
					const message = hasToolResult
						? assistant([{ type: "text", text: "brief complete" }], "stop")
						: assistant(
								[
									{
										type: "toolCall",
										id: "inspect-1",
										name: "inspect",
										arguments: { path: "README.md" },
									},
								],
								"toolUse",
							);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: hasToolResult ? "stop" : "toolUse", message });
				});
				return stream;
			},
		});
		const authStorage = AuthStorage.inMemory();
		const resourceLoader = {
			...createTestResourceLoader(),
			getSystemPrompt: (target: "main" | "spawn") => (target === "spawn" ? "spawn custom prompt" : undefined),
			getAppendSystemPrompt: () => ["shared appended instructions"],
		};
		const session = new AgentSession({
			agent: parentAgent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader,
			customTools: [
				{
					name: "inspect",
					label: "Inspect",
					description: "Inspect a file",
					parameters: Type.Object({ path: Type.String() }),
					execute,
				},
			],
			initialActiveToolNames: ["inspect"],
		});
		const events: string[] = [];
		const spawned = session.spawnAgent({
			model,
			systemPrompt: "isolated child prompt",
			thinkingLevel: "high",
			toolNames: ["inspect"],
			onEvent: (event) => {
				events.push(event.type);
			},
		});

		try {
			expect(session.systemPrompt).toContain("Ponytail");
			expect(session.systemPrompt).toContain("shared appended instructions");
			expect(session.systemPrompt).not.toContain("spawn custom prompt");
			expect(await spawned.prompt("Prepare a brief")).toBe("brief complete");
			expect(execute).toHaveBeenCalledTimes(1);
			expect(seenSystemPrompts).toHaveLength(2);
			for (const systemPrompt of seenSystemPrompts) {
				expect(systemPrompt).toContain("spawn custom prompt");
				expect(systemPrompt).toContain("shared appended instructions");
				expect(systemPrompt).toContain("isolated child prompt");
				expect(systemPrompt).not.toContain("Ponytail");
			}
			expect(events).toContain("tool_execution_start");
			expect(parentAgent.state.messages).toHaveLength(0);
			await spawned.appendUserMessage("direct user correction");
			await spawned.prompt("next orchestration");
			expect(JSON.stringify(seenMessages.at(-1))).toContain("direct user correction");
		} finally {
			spawned.dispose();
			session.dispose();
		}
	});
});
