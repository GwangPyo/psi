import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
	buildSystemPrompt,
	injectRuntimeTools,
	injectToolGuidance,
	loadOrCreateProjectSystemPrompt,
	PROJECT_SYSTEM_PROMPT_FILENAME,
	writeProjectSystemPrompt,
} from "../src/core/system-prompt.ts";

describe("project system prompt", () => {
	test("creates system_prompt.md from the generated default and returns the same content", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-system-prompt-test-"));
		const generated = "generated default prompt";

		expect(loadOrCreateProjectSystemPrompt(cwd, generated)).toBe(generated);
		expect(await fs.promises.readFile(path.join(cwd, PROJECT_SYSTEM_PROMPT_FILENAME), "utf8")).toBe(generated);

		await fs.promises.rm(cwd, { recursive: true, force: true });
	});

	test("uses an existing system_prompt.md without overwriting user edits", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-system-prompt-test-"));
		const promptPath = path.join(cwd, PROJECT_SYSTEM_PROMPT_FILENAME);
		await fs.promises.writeFile(promptPath, "user-edited prompt", "utf8");

		expect(loadOrCreateProjectSystemPrompt(cwd, "new generated prompt")).toBe("user-edited prompt");
		expect(await fs.promises.readFile(promptPath, "utf8")).toBe("user-edited prompt");

		await fs.promises.rm(cwd, { recursive: true, force: true });
	});

	test("explicit rebuild replaces system_prompt.md", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-system-prompt-test-"));
		const promptPath = path.join(cwd, PROJECT_SYSTEM_PROMPT_FILENAME);
		await fs.promises.writeFile(promptPath, "user-edited prompt", "utf8");

		expect(writeProjectSystemPrompt(cwd, "rebuilt prompt")).toBe(promptPath);
		expect(await fs.promises.readFile(promptPath, "utf8")).toBe("rebuilt prompt");

		await fs.promises.rm(cwd, { recursive: true, force: true });
	});
});

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

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes minimal implementation discipline", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Use the first sufficient option");
			expect(prompt).toContain("Fix root causes at the shared seam");
			expect(prompt).toContain("Avoid speculative abstractions, dependencies, boilerplate, and files");
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
