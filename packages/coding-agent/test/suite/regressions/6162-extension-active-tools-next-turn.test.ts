import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

describe("extension active tools next-turn refresh", () => {
	it("applies pi.setActiveTools before the next provider request in the same run", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "switch_tools",
					label: "Switch Tools",
					description: "Switch the active extension tool set",
					promptSnippet: "Switch to the next extension tool",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools(["after_switch"]);
						return {
							content: [{ type: "text", text: "switched" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_switch",
					label: "After Switch",
					description: "Tool that should be available after switching",
					promptSnippet: "Run after the active tool set changes",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			extensionFactories,
		});

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);

			const providerToolNames: string[][] = [];
			harness.setResponses([
				(context) => {
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage("done");
				},
			]);

			expect(harness.session.getActiveToolNames()).toEqual(["switch_tools"]);

			await harness.session.prompt("start");

			expect(harness.session.getActiveToolNames()).toEqual(["after_switch"]);
			expect(providerToolNames).toEqual([["switch_tools"], ["after_switch"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("lets an isolated subagent execute a selected guided tool without exposing guidance to the main agent", async () => {
		let executions = 0;
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "guided_tool",
					label: "Guided Tool",
					description: "Run the guided operation",
					promptSnippet: "Run the guided operation",
					promptGuidelines: ["Inspect the guided result before deciding the next step."],
					parameters: Type.Object({}),
					execute: async () => {
						executions++;
						return {
							content: [{ type: "text", text: "guided" }],
							details: {},
						};
					},
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.session.setActiveToolsByName(["guided_tool"]);
			const providerRequests: Array<{ systemPrompt: string; tools: string[]; toolResults: string[] }> = [];
			const recordRequest = (context: Context) => {
				providerRequests.push({
					systemPrompt: context.systemPrompt ?? "",
					tools: (context.tools ?? []).map((tool) => tool.name),
					toolResults: context.messages
						.filter((message) => message.role === "toolResult")
						.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? ""),
				});
			};
			harness.setResponses([
				(context) => {
					recordRequest(context);
					return fauxAssistantMessage(fauxToolCall("guided_tool", {}), { stopReason: "toolUse" });
				},
				(context) => {
					recordRequest(context);
					return fauxAssistantMessage(fauxToolCall("guided_tool", {}), { stopReason: "toolUse" });
				},
				(context) => {
					recordRequest(context);
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(providerRequests).toHaveLength(3);
			expect(providerRequests[0].systemPrompt).toContain("- guided_tool: Run the guided operation");
			expect(providerRequests[0].systemPrompt).not.toContain("Inspect the guided result");
			expect(providerRequests[1].tools).toEqual(["guided_tool"]);
			expect(providerRequests[1].systemPrompt).toContain('<tool_guidance tool="guided_tool">');
			expect(providerRequests[1].systemPrompt).toContain("Inspect the guided result before deciding the next step.");
			expect(providerRequests[2].systemPrompt).not.toContain("Inspect the guided result");
			expect(providerRequests[2].toolResults).toContain("guided");
			expect(executions).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("executes the validated call when a guided tool subagent returns without calling it", async () => {
		let executions = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "guided_fallback",
						label: "Guided fallback",
						description: "Run the fallback operation",
						promptGuidelines: ["Run the selected operation exactly once."],
						parameters: Type.Object({}),
						execute: async () => {
							executions++;
							return { content: [{ type: "text", text: "fallback result" }], details: {} };
						},
					});
				},
			],
		});

		try {
			harness.session.setActiveToolsByName(["guided_fallback"]);
			let observedResult = false;
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("guided_fallback", {}), { stopReason: "toolUse" }),
				() => fauxAssistantMessage("No tool call"),
				(context) => {
					observedResult = context.messages.some(
						(message) =>
							message.role === "toolResult" &&
							message.content.some((part) => part.type === "text" && part.text === "fallback result"),
					);
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(executions).toBe(1);
			expect(observedResult).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("stops and reports the selected provider when guided-tool delegation fails", async () => {
		let executions = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "guided_provider_failure",
						label: "Guided provider failure",
						description: "Do not run after provider failure",
						promptGuidelines: ["Run the selected operation exactly once."],
						parameters: Type.Object({}),
						execute: async () => {
							executions++;
							return { content: [{ type: "text", text: "unexpected" }], details: {} };
						},
					});
				},
			],
		});

		try {
			harness.session.setActiveToolsByName(["guided_provider_failure"]);
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("guided_provider_failure", {}), { stopReason: "toolUse" }),
				() => {
					throw new Error("quota exceeded");
				},
			]);

			await harness.session.prompt("start");

			const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
			const resultText =
				toolResult?.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n") ?? "";
			expect(executions).toBe(0);
			expect(resultText).toMatch(/^Tool-call subagent .+\/.+ failed: quota exceeded$/);
			expect(harness.session.messages.at(-1)?.role).toBe("toolResult");
		} finally {
			harness.cleanup();
		}
	});

	it("records additive active tool changes on the current tool result", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "load_more_tools",
					label: "Load More Tools",
					description: "Load more tools",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools([...pi.getActiveTools(), "after_load"]);
						return {
							content: [{ type: "text", text: "loaded" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_load",
					label: "After Load",
					description: "Tool available after loading",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.session.setActiveToolsByName(["load_more_tools"]);

			const addedToolNames: string[][] = [];
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("load_more_tools", {}), { stopReason: "toolUse" }),
				(context) => {
					addedToolNames.push(
						context.messages
							.filter((message) => message.role === "toolResult")
							.flatMap((message) => message.addedToolNames ?? []),
					);
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(harness.session.getActiveToolNames()).toEqual(["load_more_tools", "after_load"]);
			expect(addedToolNames).toEqual([["after_load"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves before_agent_start system prompt overrides when tools change mid-run", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("before_agent_start", async (event) => ({
					systemPrompt: `${event.systemPrompt}\n\nkeep this run override`,
				}));

				pi.registerTool({
					name: "switch_tools",
					label: "Switch Tools",
					description: "Switch the active extension tool set",
					promptSnippet: "Switch to the next extension tool",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools(["after_switch"]);
						return {
							content: [{ type: "text", text: "switched" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_switch",
					label: "After Switch",
					description: "Tool that should be available after switching",
					promptSnippet: "Run after the active tool set changes",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			extensionFactories,
		});

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);

			const providerSystemPrompts: string[] = [];
			const providerToolNames: string[][] = [];
			harness.setResponses([
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(providerToolNames).toEqual([["switch_tools"], ["after_switch"]]);
			expect(providerSystemPrompts).toHaveLength(2);
			expect(providerSystemPrompts[0]).toContain("keep this run override");
			expect(providerSystemPrompts[1]).toContain("keep this run override");
			expect(providerSystemPrompts[0]).toContain("- switch_tools:");
			expect(providerSystemPrompts[0]).not.toContain("- after_switch:");
			expect(providerSystemPrompts[1]).toContain("- after_switch:");
			expect(providerSystemPrompts[1]).not.toContain("- switch_tools:");
		} finally {
			harness.cleanup();
		}
	});
});
