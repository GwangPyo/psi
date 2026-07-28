import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import {
	createResearchExtension,
	parseSubagentEvidence,
	selectBackgroundModelReference,
	selectSubagentModelReference,
} from "../src/extensions/research/index.ts";
import { downloadResearchPdfs } from "../src/extensions/research/pdf-download.ts";
import type { PdfExtractionProgress } from "../src/extensions/research/pdf-mcp-client.ts";
import { appendResearchSources, createResearchWorkspace } from "../src/extensions/research/workspace.ts";

function model(provider: string, id: string, image: boolean, cost: number) {
	return {
		provider,
		id,
		input: image ? ["text", "image"] : ["text"],
		cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("research extension", () => {
	it("keeps SubAgent focus events out of persisted evidence", () => {
		expect(
			parseSubagentEvidence(`SUBAGENT_FOCUS: theorem assumptions on page 4
SUBAGENT_FOCUS: weak error bound on page 11
SUBAGENT_RESULT:
# Evidence

The bound is O(h).`),
		).toBe("# Evidence\n\nThe bound is O(h).");
	});

	it("downloads a PDF batch into the workspace papers directory", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-research-download-test-"));
		const workspace = await createResearchWorkspace(cwd, "Batch download");
		const fetchMock = vi.fn(async () => new Response(Buffer.from("%PDF-1.7\nmock"), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const results = await downloadResearchPdfs(cwd, workspace, [
			{ url: "https://example.com/a.pdf", title: "A" },
			{ url: "https://example.com/b.pdf", title: "B" },
		]);
		vi.unstubAllGlobals();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(results.every((result) => result.path && !result.error)).toBe(true);
		expect(await fs.promises.readdir(path.join(workspace.absolutePath, "papers"))).toHaveLength(2);
		await fs.promises.rm(cwd, { recursive: true, force: true });
	});

	it("keeps a file-backed source identity while adding the downloaded PDF path", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-research-workspace-test-"));
		const workspace = await createResearchWorkspace(cwd, "Evidence identity");
		expect(await appendResearchSources(workspace, [{ url: "https://example.com/paper.pdf", title: "Paper" }])).toBe(
			1,
		);
		expect(
			await appendResearchSources(workspace, [
				{ url: "https://example.com/paper.pdf", localPdfPath: "research/papers/paper.pdf" },
			]),
		).toBe(0);
		const records = (await fs.promises.readFile(path.join(workspace.absolutePath, "sources.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records).toEqual([
			expect.objectContaining({
				url: "https://example.com/paper.pdf",
				title: "Paper",
				localPdfPath: "research/papers/paper.pdf",
			}),
		]);
		await fs.promises.rm(cwd, { recursive: true, force: true });
	});

	it("routes PDF interpretation to the configured SubAgent and progress to the cheapest BackgroundAgent", () => {
		const models = [
			model("provider", "configured-text-only", false, 0.01),
			model("provider", "expensive-vlm", true, 5),
			model("provider", "cheap-vlm", true, 1),
		];

		expect(selectSubagentModelReference(models as never, "provider/configured-text-only")).toBeUndefined();
		expect(selectSubagentModelReference(models as never, "provider/expensive-vlm")).toBe("provider/expensive-vlm");
		expect(selectSubagentModelReference(models as never, undefined, "provider/cheap-vlm")).toBe("provider/cheap-vlm");
		expect(selectBackgroundModelReference(models as never)).toBe("provider/configured-text-only");
	});

	it("runs PDF extraction in the SubAgent and streams BackgroundAgent progress", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-research-extension-test-"));
		const workspace = await createResearchWorkspace(cwd, "Extract theorem 2");
		const runSubagentPdf = vi.fn(
			async (options: { onProgress?: (progress: { stage: "focus"; text: string }) => void }) => {
				options.onProgress?.({ stage: "focus", text: "Theorem 2 stability assumptions" });
				return "# Extracted result";
			},
		);
		const onUpdate = vi.fn();
		let tool: ToolDefinition | undefined;
		createResearchExtension({
			getSubagentModelReference: () => "provider/mid-vlm",
			getBackgroundModelReference: () => "provider/minimum-cost-model",
			interpretExtractionIntent: vi.fn(async (_ctx, task) => task),
			runSubagentPdf,
		})({
			on: vi.fn(),
			registerMessageRenderer: vi.fn(),
			getActiveTools: () => [],
			getAllTools: () => [],
			registerCommand: vi.fn(),
			registerTool: (definition: ToolDefinition) => {
				tool = definition;
			},
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI);

		const result = await tool?.execute(
			"call-1",
			{ source: "paper.pdf", task: "Extract theorem 2", format: "auto" },
			undefined,
			onUpdate,
			{
				cwd,
				sessionManager: { getSessionId: () => "session-test" },
			} as unknown as ExtensionContext,
		);

		expect(runSubagentPdf).toHaveBeenCalledWith({
			cwd,
			subagentModelReference: "provider/mid-vlm",
			backgroundModelReference: "provider/minimum-cost-model",
			source: "paper.pdf",
			task: "Extract theorem 2",
			format: "auto",
			signal: undefined,
			onProgress: expect.any(Function),
		});
		expect(onUpdate).toHaveBeenCalledWith({
			content: [{ type: "text", text: "Theorem 2 stability assumptions" }],
			details: undefined,
		});
		expect(result?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("SubAgent model: provider/mid-vlm"),
		});
		const outputDirectory = path.join(workspace.absolutePath, "evidence");
		const outputFiles = await fs.promises.readdir(outputDirectory);
		expect(outputFiles).toHaveLength(1);
		expect(await fs.promises.readFile(path.join(outputDirectory, outputFiles[0]!), "utf8")).toBe(
			"# Extracted result",
		);
		await fs.promises.rm(cwd, { recursive: true, force: true });
	});

	it("exposes modular slash commands and keeps collection separate from extraction", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-research-command-test-"));
		const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
		const sendMessage = vi.fn();
		const notify = vi.fn();
		const input = vi.fn(async () => "3");
		const setActiveTools = vi.fn();
		const runSubagentPdf = vi.fn(
			async (options: {
				onProgress?: (
					progress: PdfExtractionProgress | { stage: "interpretation" } | { stage: "focus"; text: string },
				) => void;
			}) => {
				options.onProgress?.({ stage: "metadata", pageCount: 12, title: "Actual Paper Title" });
				options.onProgress?.({ stage: "interpretation" });
				options.onProgress?.({
					stage: "focus",
					text: "Weak convergence error bounds and their implementation assumptions",
				});
				return "# Task-specific evidence\n\nFinding on page 2.";
			},
		);
		const setWidget = vi.fn();
		const interpretExtractionIntent = vi.fn(async () => "Check deviations from the current Python implementation.");
		const eventHandlers = new Map<string, (event?: unknown) => unknown>();
		const messageRenderers = new Map<string, unknown>();
		const originalTools = ["bash", "read", "write", "mcp"];
		createResearchExtension({
			getSubagentModelReference: () => "provider/mid-vlm",
			getBackgroundModelReference: () => "provider/cheap-model",
			interpretExtractionIntent,
			runSubagentPdf,
		})({
			on: (event: string, handler: () => void) => eventHandlers.set(event, handler),
			registerMessageRenderer: (customType: string, renderer: unknown) => messageRenderers.set(customType, renderer),
			getActiveTools: () => originalTools,
			getAllTools: () =>
				["mcp", "research_candidates_review", "research_report_write", "research_papers_list", "research_pdf"].map(
					(name) => ({ name }),
				),
			registerCommand: (
				name: string,
				command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => commands.set(name, command.handler),
			registerTool: vi.fn(),
			sendMessage,
			setActiveTools,
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd,
			ui: {
				editor: vi.fn(async (_prompt: string, initial: string) => initial),
				input,
				notify,
				setWidget,
				theme: { fg: vi.fn((_color: string, text: string) => text) },
			},
		} as unknown as ExtensionCommandContext;
		const discoveredResources = eventHandlers.get("resources_discover")?.() as { skillPaths?: string[] } | undefined;
		expect(discoveredResources?.skillPaths).toHaveLength(1);
		expect(messageRenderers.has("research-extraction-request")).toBe(true);
		expect(
			await fs.promises.stat(path.join(discoveredResources?.skillPaths?.[0] ?? "", "pdf-to-latex", "SKILL.md")),
		).toBeDefined();

		await commands.get("collect_papers")?.("sparse attention kernels", ctx);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(input).toHaveBeenCalledWith("How many papers should I collect?", "5");
		expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
			customType: "research-stage-instruction",
			content: expect.stringContaining("Target accepted paper count: 3"),
			display: false,
		});
		expect(sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: true });
		expect(sendMessage.mock.calls[0]?.[0].content).toContain("Do not start a discussion or modify code");
		expect(notify).toHaveBeenCalledWith("Searching and screening papers for direct answerability…", "info");
		expect(setActiveTools).toHaveBeenLastCalledWith(["mcp", "research_candidates_review", "research_report_write"]);
		expect(setActiveTools.mock.calls.at(-1)?.[0]).not.toContain("bash");
		expect(await fs.promises.readdir(path.join(cwd, "research"))).toEqual(
			expect.arrayContaining(["discussions", "evidence", "manifest.json", "papers"]),
		);
		eventHandlers.get("agent_end")?.();
		expect(setActiveTools).toHaveBeenLastCalledWith(originalTools);

		await fs.promises.writeFile(path.join(cwd, "research", "papers", "paper-a.pdf"), "%PDF-1.7\nmock");
		await commands.get("extract_papers")?.("compare implementation constraints", ctx);
		expect(interpretExtractionIntent).toHaveBeenCalledTimes(1);
		expect(interpretExtractionIntent).toHaveBeenCalledWith(ctx, "compare implementation constraints");
		expect(sendMessage).toHaveBeenCalledTimes(3);
		expect(sendMessage.mock.calls[1]?.[0]).toEqual({
			customType: "research-extraction-request",
			content: "compare implementation constraints",
			display: true,
		});
		expect(runSubagentPdf).toHaveBeenCalledWith({
			cwd,
			subagentModelReference: "provider/mid-vlm",
			backgroundModelReference: "provider/cheap-model",
			source: "research/papers/paper-a.pdf",
			task: "Original user request: compare implementation constraints\n\nMain-model intention brief:\nCheck deviations from the current Python implementation.",
			format: "auto",
			signal: undefined,
			onProgress: expect.any(Function),
		});
		expect(setWidget).toHaveBeenCalledWith(
			"research-extraction",
			expect.arrayContaining([expect.stringContaining("Weak convergence error bounds")]),
			{ placement: "aboveEditor" },
		);
		expect(setWidget).toHaveBeenLastCalledWith("research-extraction", undefined, { placement: "aboveEditor" });
		expect(sendMessage.mock.calls[2]?.[0]).toMatchObject({
			customType: "research-stage-instruction",
			content: expect.stringContaining("No tool calls are needed now"),
			display: false,
		});
		expect(sendMessage.mock.calls[2]?.[0].content).toContain("Do not turn the task into a generic paper summary");
		expect(sendMessage.mock.calls[2]?.[0].content).toContain("# Task-specific evidence");
		expect(notify).toHaveBeenCalledWith("Extracting task-specific evidence from 1 PDFs…", "info");
		expect(setActiveTools).toHaveBeenLastCalledWith([]);

		await commands.get("research_status")?.("", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("1 PDFs, 1 evidence"), "info");
		expect(commands.has("discuss_papers")).toBe(false);
		expect(commands.has("apply_research")).toBe(false);
		await fs.promises.rm(cwd, { recursive: true, force: true });
	});
});
