import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import {
	ADVERSARIAL_CONVERSATION_BATCH_TURNS,
	type AdversarialAgentName,
	type AdversarialConversationAgent,
	AdversarialConversationInterruptedError,
	createAdversarialConversationExtension,
	getAdversarialConversationToolNames,
	guardAdversarialReadOnlyToolCall,
	parseAdversarialAgentCount,
	runAdversarialConversationBatch,
} from "../src/extensions/adversarial-conversation/index.ts";

function createFakeAgent(
	name: string,
): AdversarialConversationAgent & { prompts: string[]; stop: ReturnType<typeof vi.fn> } {
	const prompts: string[] = [];
	const interrupt = vi.fn(async () => {});
	const deliverUserInput = vi.fn(async () => {});
	const stop = vi.fn(async () => {});
	return {
		prompts,
		interrupt,
		deliverUserInput,
		stop,
		async respond(prompt) {
			prompts.push(prompt);
			return `${name}-statement-${prompts.length}`;
		},
	};
}

describe("adversarial conversation", () => {
	it("is always registered as a core slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual(expect.objectContaining({ name: "adversarial_discussion" }));
	});

	it("loads its bundled implementation when extension discovery is disabled", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-adversarial-core-command-test-"));
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: path.join(cwd, "agent"),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [createAdversarialConversationExtension()],
		});

		await resourceLoader.reload();

		expect(
			resourceLoader
				.getExtensions()
				.extensions.some((extension) => extension.commands.has("adversarial_discussion")),
		).toBe(true);
		await fs.promises.rm(cwd, { recursive: true, force: true });
	});

	it("uses two agents by default for exactly 30 turns", async () => {
		const agent1 = createFakeAgent("agent_1");
		const agent2 = createFakeAgent("agent_2");

		const result = await runAdversarialConversationBatch({
			goal: "Evaluate proposal X",
			participants: [
				{ name: "agent_1", agent: agent1 },
				{ name: "agent_2", agent: agent2 },
			],
			startTurn: 1,
		});

		expect(result.turns).toHaveLength(ADVERSARIAL_CONVERSATION_BATCH_TURNS);
		expect(result.nextTurn).toBe(31);
		expect(result.turns.map((turn) => turn.speaker)).toEqual(
			Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? "agent_1" : "agent_2")),
		);
		expect(agent1.prompts).toHaveLength(15);
		expect(agent2.prompts).toHaveLength(15);
		expect(agent1.prompts[0]).toContain("strongest initial position");
		expect(agent2.prompts[0]).toContain("agent_1-statement-1");
		expect(agent1.prompts[1]).toContain("agent_1-statement-1");
		expect(agent1.prompts[1]).toContain("agent_2-statement-1");
	});

	it("rotates three or more agents in round-robin order", async () => {
		const agents = [createFakeAgent("agent_1"), createFakeAgent("agent_2"), createFakeAgent("agent_3")];

		const result = await runAdversarialConversationBatch({
			goal: "Evaluate proposal X",
			participants: agents.map((agent, index) => ({
				name: `agent_${index + 1}` as AdversarialAgentName,
				agent,
			})),
			startTurn: 1,
			turnCount: 7,
		});

		expect(result.turns.map((turn) => turn.speaker)).toEqual([
			"agent_1",
			"agent_2",
			"agent_3",
			"agent_1",
			"agent_2",
			"agent_3",
			"agent_1",
		]);
		expect(agents.map((agent) => agent.prompts.length)).toEqual([3, 2, 2]);
	});

	it("accepts two as the minimum custom agent count", () => {
		expect(parseAdversarialAgentCount("2")).toBe(2);
		expect(parseAdversarialAgentCount("1")).toBeUndefined();
		expect(parseAdversarialAgentCount("0")).toBeUndefined();
		expect(parseAdversarialAgentCount("2.5")).toBeUndefined();
	});

	it("passes active non-mutating tools and the built-in read-only inspection tools to discussion agents", () => {
		expect(
			getAdversarialConversationToolNames(["read", "edit", "write", "research_pdf", "project_graph_search"]),
		).toEqual(["read", "research_pdf", "project_graph_search", "bash", "grep", "find", "ls"]);
	});

	it("blocks mutating tools and non-read-only bash commands in spawned discussion agents", () => {
		expect(guardAdversarialReadOnlyToolCall("read", { path: "README.md" })).toBeUndefined();
		expect(guardAdversarialReadOnlyToolCall("bash", { command: "git status --short" })).toBeUndefined();
		expect(guardAdversarialReadOnlyToolCall("edit", { path: "README.md" })).toEqual(
			expect.objectContaining({ block: true }),
		);
		expect(guardAdversarialReadOnlyToolCall("bash", { command: "rm README.md" })).toEqual(
			expect.objectContaining({ block: true }),
		);
	});

	it("cancels the current response and retries the same turn with the interrupt in shared history", async () => {
		let rejectCurrentResponse: ((error: Error) => void) | undefined;
		const prompts: string[] = [];
		const queuedInputs: string[] = [];
		const agent1: AdversarialConversationAgent = {
			async respond(prompt) {
				prompts.push(prompt);
				if (prompts.length > 1) return "response after interrupt";
				return await new Promise<string>((_resolve, reject) => {
					rejectCurrentResponse = reject;
				});
			},
			async interrupt() {
				rejectCurrentResponse?.(new AdversarialConversationInterruptedError());
			},
			async deliverUserInput() {},
			async stop() {},
		};
		const agent2 = createFakeAgent("agent_2");

		const resultPromise = runAdversarialConversationBatch({
			goal: "Evaluate the numerical implementation",
			participants: [
				{ name: "agent_1", agent: agent1 },
				{ name: "agent_2", agent: agent2 },
			],
			startTurn: 1,
			turnCount: 1,
			takeUserInputs: () => queuedInputs.splice(0),
		});

		await vi.waitFor(() => expect(prompts).toHaveLength(1));
		queuedInputs.push("NaN 자체가 아니라 모델의 의미 보존을 논의해");
		await agent1.interrupt();
		const result = await resultPromise;

		expect(result.turns).toEqual([{ turn: 1, speaker: "agent_1", text: "response after interrupt" }]);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain('"speaker":"user"');
		expect(prompts[1]).toContain("NaN 자체가 아니라 모델의 의미 보존을 논의해");
	});

	it("continues with accumulated discussion history and global turn number", async () => {
		const agent1 = createFakeAgent("agent_1");
		const agent2 = createFakeAgent("agent_2");

		const result = await runAdversarialConversationBatch({
			goal: "Evaluate proposal X",
			participants: [
				{ name: "agent_1", agent: agent1 },
				{ name: "agent_2", agent: agent2 },
			],
			startTurn: 31,
			history: [
				{ turn: 29, speaker: "agent_1", text: "agent_1 previous statement" },
				{ turn: 30, speaker: "agent_2", text: "agent_2 previous statement" },
			],
			turnCount: 2,
		});

		expect(result.turns.map((turn) => [turn.turn, turn.speaker])).toEqual([
			[31, "agent_1"],
			[32, "agent_2"],
		]);
		expect(agent1.prompts[0]).toContain("agent_1 previous statement");
		expect(agent1.prompts[0]).toContain("agent_2 previous statement");
	});

	it("delivers live user input to all agents through the shared discussion context", async () => {
		const agent1 = createFakeAgent("agent_1");
		const agent2 = createFakeAgent("agent_2");
		const agent3 = createFakeAgent("agent_3");
		const queuedInputs = ["projection 횟수보다 경계 계약을 우선해서 평가해"];

		await runAdversarialConversationBatch({
			goal: "Evaluate projection design",
			participants: [
				{ name: "agent_1", agent: agent1 },
				{ name: "agent_2", agent: agent2 },
				{ name: "agent_3", agent: agent3 },
			],
			startTurn: 1,
			turnCount: 3,
			takeUserInputs: () => queuedInputs.splice(0),
		});

		expect(agent1.prompts[0]).toContain('"speaker":"user"');
		expect(agent1.prompts[0]).toContain("projection 횟수보다 경계 계약을 우선해서 평가해");
		expect(agent2.prompts[0]).toContain('"speaker":"user"');
		expect(agent2.prompts[0]).toContain("projection 횟수보다 경계 계약을 우선해서 평가해");
		expect(agent3.prompts[0]).toContain('"speaker":"user"');
		expect(agent3.prompts[0]).toContain("projection 횟수보다 경계 계약을 우선해서 평가해");
	});

	it("records the full discussion and hands it to the main agent", async () => {
		const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
		const registeredEvents: string[] = [];
		const contextHandlers: Array<(event: { messages: unknown[] }) => Promise<{ messages: unknown[] }>> = [];
		const sentMessages: Array<{
			message: { customType: string; content: unknown };
			options: { triggerTurn?: boolean } | undefined;
		}> = [];
		const agent1 = createFakeAgent("agent_1");
		const deliveredBeforeRetry: string[] = [];
		agent1.deliverUserInput = vi.fn(async () => {
			deliveredBeforeRetry.push("agent_1");
		});
		let rejectAgent1Response: ((error: Error) => void) | undefined;
		agent1.respond = async (prompt) => {
			agent1.prompts.push(prompt);
			if (agent1.prompts.length > 1) {
				expect(deliveredBeforeRetry).toEqual(["agent_1", "agent_2", "agent_3"]);
				return `agent_1-statement-${agent1.prompts.length - 1}`;
			}
			return await new Promise<string>((_resolve, reject) => {
				rejectAgent1Response = reject;
			});
		};
		agent1.interrupt = vi.fn(async () => {
			rejectAgent1Response?.(new AdversarialConversationInterruptedError());
		});
		const agent2 = createFakeAgent("agent_2");
		agent2.deliverUserInput = vi.fn(async () => {
			deliveredBeforeRetry.push("agent_2");
		});
		const agent3 = createFakeAgent("agent_3");
		agent3.deliverUserInput = vi.fn(async () => {
			deliveredBeforeRetry.push("agent_3");
		});
		const agentsByName = new Map<AdversarialAgentName, AdversarialConversationAgent>([
			["agent_1", agent1],
			["agent_2", agent2],
			["agent_3", agent3],
		]);
		const prepareDiscussionBrief = vi.fn(async () => "Verified shared discussion brief");
		const createAgent = vi.fn(async (name: AdversarialAgentName) => agentsByName.get(name)!);
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-discussion-test-"));
		const extension = createAdversarialConversationExtension({
			prepareDiscussionBrief,
			createAgent,
			getDefaultModelReference: () => "provider/default-model",
		});
		extension({
			on: (event: string, handler: unknown) => {
				registeredEvents.push(event);
				if (event === "context") {
					contextHandlers.push(handler as (event: { messages: unknown[] }) => Promise<{ messages: unknown[] }>);
				}
			},
			registerCommand: (
				name: string,
				command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => commands.set(name, command.handler),
			registerFlag: vi.fn(),
			getFlag: vi.fn(() => false),
			getActiveTools: () => ["read", "bash", "edit", "write", "research_pdf"],
			sendMessage: (
				message: { customType: string; content: unknown },
				options: { triggerTurn?: boolean } | undefined,
			) => sentMessages.push({ message, options }),
		} as unknown as ExtensionAPI);

		const editor = vi
			.fn<(title: string, initialValue: string) => Promise<string | undefined>>()
			.mockResolvedValueOnce("Evaluate proposal X")
			.mockResolvedValueOnce("3")
			.mockResolvedValueOnce("7");
		const select = vi
			.fn<(title: string, options: string[]) => Promise<string | undefined>>()
			.mockResolvedValueOnce("more_than_2")
			.mockResolvedValueOnce("user_input")
			.mockResolvedValueOnce("provider/agent-1-model")
			.mockResolvedValueOnce("provider/agent-2-model")
			.mockResolvedValueOnce("provider/agent-3-model");
		const confirm = vi.fn(async () => false);
		let releaseIdle = () => {};
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const ctx = {
			hasUI: true,
			cwd,
			model: { provider: "provider", id: "main-model" },
			sessionManager: {
				getSessionId: () => "session-test",
				buildContextEntries: () => [
					{ type: "message", message: { role: "user", content: "Existing projection discussion context" } },
					{
						type: "message",
						message: { role: "assistant", content: [{ type: "text", text: "Inspected service layer" }] },
					},
				],
			},
			ui: {
				editor,
				select,
				confirm,
				notify: vi.fn(),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				theme: { fg: (_name: string, text: string) => text },
			},
			waitForIdle: vi.fn(() => idle),
			isProjectTrusted: () => true,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "provider", id: "default-model" },
					{ provider: "provider", id: "agent-1-model" },
					{ provider: "provider", id: "agent-2-model" },
					{ provider: "provider", id: "agent-3-model" },
				],
			},
		} as unknown as ExtensionCommandContext;

		const command = commands.get("adversarial_discussion");
		if (!command) throw new Error("Missing adversarial conversation command");
		const commandPromise = command("prefilled goal", ctx);
		await vi.waitFor(() => expect(ctx.waitForIdle).toHaveBeenCalledTimes(1));
		releaseIdle();
		await vi.waitFor(() => expect(agent1.prompts).toHaveLength(1));
		await commands.get("interrupt")?.("사용자 개입을 두 관점에서 검토해", ctx);
		expect(agent1.interrupt).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith("User message delivered to all 3 discussion agents.", "info");
		expect(agent1.deliverUserInput).toHaveBeenCalledWith("사용자 개입을 두 관점에서 검토해");
		expect(agent2.deliverUserInput).toHaveBeenCalledWith("사용자 개입을 두 관점에서 검토해");
		expect(agent3.deliverUserInput).toHaveBeenCalledWith("사용자 개입을 두 관점에서 검토해");
		const immediatelyDisplayedInput = sentMessages.find(
			({ message }) => message.customType === "adversarial-conversation-user-input",
		);
		expect(immediatelyDisplayedInput?.message.content).toContain("사용자 개입을 두 관점에서 검토해");
		await commandPromise;

		expect(editor).toHaveBeenCalledTimes(3);
		expect(registeredEvents).not.toContain("input");
		expect(commands.has("interrupt")).toBe(true);
		expect(editor).toHaveBeenNthCalledWith(1, "Goal", "prefilled goal");
		expect(editor).toHaveBeenNthCalledWith(2, "Number of agents", "3");
		expect(editor).toHaveBeenNthCalledWith(3, "Turns per batch", "20");
		expect(select).toHaveBeenNthCalledWith(1, "Select number of agents", ["2", "more_than_2"]);
		expect(select).toHaveBeenNthCalledWith(2, "Select turns per batch", ["5", "10", "15", "30", "user_input"]);
		expect(select).toHaveBeenNthCalledWith(3, "Select agent_1 model", [
			"provider/default-model · default",
			"provider/agent-1-model",
			"provider/agent-2-model",
			"provider/agent-3-model",
		]);
		expect(select).toHaveBeenNthCalledWith(4, "Select agent_2 model · 1 selected", [
			"provider/default-model · default",
			"provider/agent-1-model",
			"provider/agent-2-model",
			"provider/agent-3-model",
		]);
		expect(select).toHaveBeenNthCalledWith(5, "Select agent_3 model · 2 selected", [
			"provider/default-model · default",
			"provider/agent-1-model",
			"provider/agent-2-model",
			"provider/agent-3-model",
		]);
		const expectedPriorContext =
			"[User]\nExisting projection discussion context\n\n[Main agent]\nInspected service layer";
		expect(prepareDiscussionBrief).toHaveBeenCalledTimes(1);
		expect(prepareDiscussionBrief).toHaveBeenCalledWith(
			"Evaluate proposal X",
			cwd,
			{ provider: "provider", id: "main-model" },
			expectedPriorContext,
			["read", "bash", "research_pdf", "grep", "find", "ls"],
			expect.any(Function),
		);
		expect(createAgent).toHaveBeenNthCalledWith(
			1,
			"agent_1",
			"Evaluate proposal X",
			cwd,
			expect.objectContaining({ provider: "provider", id: "agent-1-model" }),
			"Verified shared discussion brief",
			["read", "bash", "research_pdf", "grep", "find", "ls"],
		);
		expect(createAgent).toHaveBeenNthCalledWith(
			2,
			"agent_2",
			"Evaluate proposal X",
			cwd,
			expect.objectContaining({ provider: "provider", id: "agent-2-model" }),
			"Verified shared discussion brief",
			["read", "bash", "research_pdf", "grep", "find", "ls"],
		);
		expect(createAgent).toHaveBeenNthCalledWith(
			3,
			"agent_3",
			"Evaluate proposal X",
			cwd,
			expect.objectContaining({ provider: "provider", id: "agent-3-model" }),
			"Verified shared discussion brief",
			["read", "bash", "research_pdf", "grep", "find", "ls"],
		);
		expect(agent1.prompts.some((prompt) => prompt.includes("사용자 개입을 두 관점에서 검토해"))).toBe(true);
		expect(agent2.prompts.some((prompt) => prompt.includes("사용자 개입을 두 관점에서 검토해"))).toBe(true);
		expect(agent3.prompts.some((prompt) => prompt.includes("사용자 개입을 두 관점에서 검토해"))).toBe(true);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledWith("7 turns completed", "Continue for another 7 turns?");
		expect(sentMessages.filter(({ message }) => message.customType === "adversarial-conversation-turn")).toHaveLength(
			7,
		);
		const startMessage = sentMessages.find(({ message }) => message.customType === "adversarial-conversation-start");
		expect(startMessage?.message.content).toContain("agent_1 (provider/agent-1-model)");
		expect(startMessage?.message.content).toContain("agent_2 (provider/agent-2-model)");
		expect(startMessage?.message.content).toContain("agent_3 (provider/agent-3-model)");
		expect(startMessage?.message.content).toContain(
			"use /interrupt <message> to send input to all discussion agents",
		);
		const firstTurnMessage = sentMessages.find(
			({ message }) => message.customType === "adversarial-conversation-turn",
		);
		expect(firstTurnMessage?.message.content).toContain("agent_1 (provider/agent-1-model) · turn 1");
		expect(ctx.ui.notify).toHaveBeenCalledWith("User message delivered to all 3 discussion agents.", "info");
		const deliveredUserMessage = sentMessages.find(
			({ message }) => message.customType === "adversarial-conversation-user-input",
		);
		expect(deliveredUserMessage?.message.content).toContain("User message delivered to discussion");
		expect(deliveredUserMessage?.message.content).toContain(
			"agent_1 (provider/agent-1-model) + agent_2 (provider/agent-2-model) + agent_3 (provider/agent-3-model)",
		);
		const runningWidgets = vi
			.mocked(ctx.ui.setWidget)
			.mock.calls.filter((call) => call[0] === "adversarial-conversation-running");
		expect(
			runningWidgets.some(
				(call) => Array.isArray(call[1]) && call[1][0] === "⠋ agent_1 (provider/agent-1-model) · turn 1 · running",
			),
		).toBe(true);
		expect(runningWidgets[0]?.[2]).toEqual({ placement: "aboveEditor" });
		const helpWidgets = vi
			.mocked(ctx.ui.setWidget)
			.mock.calls.filter((call) => call[0] === "adversarial-conversation-help");
		expect(helpWidgets[0]?.[1]).toEqual(["use /interrupt <message> to send input to all discussion agents"]);
		expect(helpWidgets[0]?.[2]).toEqual({ placement: "aboveEditor" });
		expect(helpWidgets.at(-1)?.[1]).toBeUndefined();
		const interruptWidgets = vi
			.mocked(ctx.ui.setWidget)
			.mock.calls.filter((call) => call[0] === "adversarial-conversation-interrupt");
		expect(
			interruptWidgets.some(
				(call) =>
					Array.isArray(call[1]) &&
					call[1][0] === "[interrupting] 사용자 개입을 두 관점에서 검토해" &&
					call[2]?.placement === "aboveEditor",
			),
		).toBe(true);
		expect(
			interruptWidgets.some(
				(call) =>
					Array.isArray(call[1]) &&
					call[1][0] === "[delivered] 사용자 개입을 두 관점에서 검토해" &&
					call[2]?.placement === "aboveEditor",
			),
		).toBe(true);
		const handoff = sentMessages.find(({ message }) => message.customType === "adversarial-conversation-handoff");
		expect(handoff?.options).toEqual({ triggerTurn: true });

		const discussionDirectory = path.join(cwd, ".pi", "agent-discussions", "session-test");
		const discussionFiles = await fs.promises.readdir(discussionDirectory);
		expect(discussionFiles).toHaveLength(1);
		const transcript = await fs.promises.readFile(path.join(discussionDirectory, discussionFiles[0]!), "utf8");
		expect(transcript).toContain("## Goal\n\nEvaluate proposal X");
		expect(transcript).toContain("## Main-agent discussion brief\n\nVerified shared discussion brief");
		expect(transcript).toContain("### user · before turn 1\n\n사용자 개입을 두 관점에서 검토해");
		expect(transcript).toContain("### agent_1 (provider/agent-1-model) · turn 1");
		expect(transcript).toContain("### agent_1 (provider/agent-1-model) · turn 7");

		const filteredContext = await contextHandlers[0]!({
			messages: [
				{ role: "custom", customType: "adversarial-conversation-turn" },
				{ role: "custom", customType: "adversarial-conversation-handoff" },
			],
		});
		expect(filteredContext.messages).toEqual([{ role: "custom", customType: "adversarial-conversation-handoff" }]);
		expect(agent1.stop).toHaveBeenCalledTimes(1);
		expect(agent2.stop).toHaveBeenCalledTimes(1);
		expect(agent3.stop).toHaveBeenCalledTimes(1);
		await fs.promises.rm(cwd, { recursive: true, force: true });
	});
});
