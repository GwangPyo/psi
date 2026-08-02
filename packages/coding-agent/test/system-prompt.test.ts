import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildSystemPrompt, injectRuntimeTools, injectToolGuidance } from "../src/core/system-prompt.ts";

const defaultSystemPrompt = readFileSync(
	new URL("../src/core/prompts/default-system-prompt.md", import.meta.url),
	"utf-8",
).trim();

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = injectRuntimeTools(
				buildSystemPrompt({
					selectedTools: [],
					contextFiles: [],
					skills: [],
					cwd: process.cwd(),
				}),
				[],
			);

			expect(prompt).toContain("<available_tools>");
			expect(prompt).toContain("(none)");
		});

		test("uses the packaged Markdown default even with no tools", () => {
			const cwd = process.cwd();
			const prompt = buildSystemPrompt({ selectedTools: [], contextFiles: [], skills: [], cwd });

			expect(prompt).toBe(`${defaultSystemPrompt}\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`);
		});
	});

	describe("default tools", () => {
		test("includes the ultra Markdown default without embedding a second prompt", () => {
			const prompt = buildSystemPrompt({ contextFiles: [], skills: [], cwd: process.cwd() });

			expect(prompt.startsWith(defaultSystemPrompt)).toBe(true);
			expect(prompt).toContain("Default intensity: **ultra**");
			expect(prompt).toContain("Output code first");
		});

		test("includes all tools active for the current request", () => {
			const prompt = injectRuntimeTools(buildSystemPrompt({ contextFiles: [], skills: [], cwd: process.cwd() }), [
				{ name: "read", description: "Read file contents" },
				{ name: "bash", description: "Execute bash commands" },
				{ name: "edit", description: "Make surgical edits" },
				{ name: "write", description: "Create or overwrite files" },
			]);

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});
	});

	describe("runtime tool catalog", () => {
		test("includes every active custom tool", () => {
			const prompt = injectRuntimeTools("base prompt", [
				{ name: "read", description: "Read files" },
				{ name: "dynamic_tool", description: "Run dynamic test behavior" },
			]);

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("replaces a saved legacy catalog and removes its tool guidance", () => {
			const prompt = injectRuntimeTools(
				`base prompt

Available tools:
- stale_tool: no longer active

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- stale tool guideline`,
				[{ name: "read", description: "Read files" }],
				["stale tool guideline"],
			);

			expect(prompt).not.toContain("stale_tool");
			expect(prompt).not.toContain("stale tool guideline");
			expect(prompt).toContain("- read: Read files");
		});
	});

	describe("prompt guidelines", () => {
		test("does not include tool guidance until that tool is selected", () => {
			const basePrompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(basePrompt).not.toContain("Use dynamic_tool for project summaries.");

			const selectedPrompt = injectToolGuidance(basePrompt, "dynamic_tool", [
				"Use dynamic_tool for project summaries.",
			]);
			expect(selectedPrompt).toContain('<tool_guidance tool="dynamic_tool">');
			expect(selectedPrompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("leaves the prompt unchanged when a tool has no guidance", () => {
			expect(injectToolGuidance("base prompt", "read", [])).toBe("base prompt");
		});
	});
});
