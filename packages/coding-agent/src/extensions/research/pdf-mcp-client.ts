import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getAgentDir } from "../../config.ts";

const PDF_MCP_VERSION = "1.21.0";
const PDF_READ_BATCH_SIZE = 40;
const PDF_RENDER_BATCH_SIZE = 5;
const PDF_MCP_TIMEOUT_MS = 120_000;
let pdfMcpSetupPromise: Promise<string> | undefined;

interface PdfPagePayload {
	page: number;
	text: string;
	chars: number;
	imageCount: number;
	tableCount: number;
}

export interface ExtractedPdfPage extends PdfPagePayload {
	damaged: boolean;
}

export interface RenderedPdfPage {
	page: number;
	image: ImageContent;
}

export interface SystemPdfExtraction {
	pageCount: number;
	pages: ExtractedPdfPage[];
	damagedPages: number[];
	renders: RenderedPdfPage[];
}

export type PdfExtractionProgress =
	| { stage: "connecting" }
	| { stage: "metadata"; pageCount: number; title?: string }
	| {
			stage: "native_read";
			pagesRead: number;
			pageCount: number;
			firstPage: number;
			lastPage: number;
	  }
	| { stage: "quality_check"; damagedPages: number[]; pageCount: number }
	| { stage: "render"; pagesRendered: number; pagesToRender: number };

function runSetupProcess(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env: process.env, shell: false, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (data: Buffer) => {
			stderr = `${stderr}${data.toString()}`.slice(-20_000);
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited (code=${code}, signal=${signal}). ${stderr}`));
		});
	});
}

export function ensurePdfMcpCommand(): Promise<string> {
	const virtualEnvironment = path.join(getAgentDir(), "mcp", `pdf-mcp-${PDF_MCP_VERSION}-venv`);
	const executableDirectory = process.platform === "win32" ? "Scripts" : "bin";
	const command = path.join(
		virtualEnvironment,
		executableDirectory,
		process.platform === "win32" ? "pdf-mcp.exe" : "pdf-mcp",
	);
	if (fs.existsSync(command)) return Promise.resolve(command);
	if (pdfMcpSetupPromise) return pdfMcpSetupPromise;

	pdfMcpSetupPromise = (async () => {
		await fs.promises.mkdir(path.dirname(virtualEnvironment), { recursive: true });
		await runSetupProcess(process.platform === "win32" ? "python" : "python3", ["-m", "venv", virtualEnvironment]);
		const python = path.join(
			virtualEnvironment,
			executableDirectory,
			process.platform === "win32" ? "python.exe" : "python",
		);
		await runSetupProcess(python, [
			"-m",
			"pip",
			"install",
			"--disable-pip-version-check",
			`pdf-mcp==${PDF_MCP_VERSION}`,
		]);
		if (!fs.existsSync(command)) throw new Error(`pdf-mcp installation completed without executable: ${command}`);
		return command;
	})();
	pdfMcpSetupPromise.catch(() => {
		pdfMcpSetupPromise = undefined;
	});
	return pdfMcpSetupPromise;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return undefined;
	}
}

function requireCallToolResult(value: unknown): CallToolResult {
	const record = asRecord(value);
	if (!record || !Array.isArray(record.content))
		throw new Error("pdf-mcp returned a task handle instead of a tool result");
	return value as CallToolResult;
}

function getStructuredObject(result: CallToolResult): Record<string, unknown> {
	const structured = asRecord(result.structuredContent);
	if (structured) return structured;
	for (const item of result.content) {
		if (item.type !== "text") continue;
		const parsed = parseJsonObject(item.text);
		if (parsed) return parsed;
	}
	throw new Error("pdf-mcp returned no structured JSON result");
}

function requirePositiveInteger(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`pdf-mcp returned invalid ${key}`);
	return Number(value);
}

function range(first: number, last: number): number[] {
	return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function batches(pageCount: number, size: number): number[][] {
	const result: number[][] = [];
	for (let first = 1; first <= pageCount; first += size) {
		result.push(range(first, Math.min(first + size - 1, pageCount)));
	}
	return result;
}

function isDamagedNativeText(text: string): boolean {
	const compact = text.replace(/\s/gu, "");
	if (compact.length < 80) return true;
	const replacementCharacters = compact.match(/\uFFFD/gu)?.length ?? 0;
	if (replacementCharacters / compact.length > 0.005) return true;
	const readableCharacters = compact.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
	if (readableCharacters / compact.length < 0.2) return true;
	const lines = text
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
	const isolatedLines = lines.filter((line) => Array.from(line).length <= 2).length;
	return lines.length >= 12 && isolatedLines / lines.length > 0.7;
}

function parsePages(payload: Record<string, unknown>): PdfPagePayload[] {
	if (typeof payload.error === "string") throw new Error(payload.error);
	if (!Array.isArray(payload.pages)) throw new Error("pdf-mcp returned no pages array");
	return payload.pages.map((value) => {
		const page = asRecord(value);
		if (!page || !Number.isSafeInteger(page.page) || typeof page.text !== "string") {
			throw new Error("pdf-mcp returned a malformed page");
		}
		return {
			page: Number(page.page),
			text: page.text,
			chars: typeof page.chars === "number" ? page.chars : page.text.length,
			imageCount: typeof page.image_count === "number" ? page.image_count : 0,
			tableCount: typeof page.table_count === "number" ? page.table_count : 0,
		};
	});
}

function getDocumentTitle(payload: Record<string, unknown>): string | undefined {
	const metadata = asRecord(payload.metadata);
	const title = typeof metadata?.title === "string" ? metadata.title.replace(/\s+/gu, " ").trim() : "";
	return title || undefined;
}

function parseRenderedPages(result: CallToolResult, requestedPages: number[]): RenderedPdfPage[] {
	const summaryItem = result.content.find((item) => item.type === "text");
	const summary = summaryItem?.type === "text" ? parseJsonObject(summaryItem.text) : undefined;
	const renderedPages = Array.isArray(summary?.pages_rendered)
		? summary.pages_rendered.filter((value): value is number => Number.isSafeInteger(value))
		: requestedPages;
	const images = result.content.filter((item) => item.type === "image");
	if (images.length !== renderedPages.length) {
		throw new Error(`pdf-mcp rendered ${renderedPages.length} pages but returned ${images.length} images`);
	}
	return images.map((image, index) => ({
		page: renderedPages[index]!,
		image: { type: "image", data: image.data, mimeType: image.mimeType },
	}));
}

export async function extractPdfSystemically(
	command: string,
	source: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (progress: PdfExtractionProgress) => void,
): Promise<SystemPdfExtraction> {
	onProgress?.({ stage: "connecting" });
	const client = new Client({ name: "pi-research", version: "1.0.0" });
	const cacheIdentity = typeof process.getuid === "function" ? process.getuid() : "user";
	const sourceCacheKey = createHash("sha256")
		.update(path.resolve(cwd))
		.update("\0")
		.update(source)
		.digest("hex")
		.slice(0, 16);
	const transport = new StdioClientTransport({
		command,
		cwd,
		env: {
			...getDefaultEnvironment(),
			PDF_MCP_CACHE_DIR: path.join(os.tmpdir(), `pi-pdf-mcp-${cacheIdentity}`, sourceCacheKey),
		},
		stderr: "pipe",
	});
	let startupStderr = "";
	transport.stderr?.on("data", (data: Buffer) => {
		startupStderr = `${startupStderr}${data.toString()}`.slice(-20_000);
	});
	try {
		await client.connect(transport);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const detail = startupStderr.trim();
		throw new Error(`pdf-mcp startup failed: ${reason}${detail ? `\n${detail}` : ""}`, { cause: error });
	}
	try {
		const infoResult = await client.callTool(
			{ name: "pdf_info", arguments: { path: source, detail: false } },
			undefined,
			{ signal, timeout: PDF_MCP_TIMEOUT_MS },
		);
		const info = getStructuredObject(requireCallToolResult(infoResult));
		const pageCount = requirePositiveInteger(info, "page_count");
		onProgress?.({ stage: "metadata", pageCount, title: getDocumentTitle(info) });
		const pageBatches = batches(pageCount, PDF_READ_BATCH_SIZE);
		let pagesRead = 0;
		const pageResults = await Promise.all(
			pageBatches.map(async (pageBatch) => {
				const result = await client.callTool(
					{
						name: "pdf_read_pages",
						arguments: { path: source, pages: `${pageBatch[0]}-${pageBatch.at(-1)}`, ocr: false },
					},
					undefined,
					{ signal, timeout: PDF_MCP_TIMEOUT_MS },
				);
				const parsedPages = parsePages(getStructuredObject(requireCallToolResult(result)));
				pagesRead += parsedPages.length;
				onProgress?.({
					stage: "native_read",
					pagesRead,
					pageCount,
					firstPage: pageBatch[0]!,
					lastPage: pageBatch.at(-1)!,
				});
				return parsedPages;
			}),
		);
		const pages = pageResults
			.flat()
			.sort((left, right) => left.page - right.page)
			.map((page) => ({ ...page, damaged: isDamagedNativeText(page.text) }));
		const damagedPages = pages.filter((page) => page.damaged).map((page) => page.page);
		onProgress?.({ stage: "quality_check", damagedPages, pageCount });
		let pagesRendered = 0;
		const renderResults = await Promise.all(
			batches(damagedPages.length, PDF_RENDER_BATCH_SIZE).map(async (indexes) => {
				const requestedPages = indexes.map((index) => damagedPages[index - 1]!);
				const result = await client.callTool(
					{
						name: "pdf_render_pages",
						arguments: { path: source, pages: requestedPages.join(","), dpi: 200 },
					},
					undefined,
					{ signal, timeout: PDF_MCP_TIMEOUT_MS },
				);
				const renderedPages = parseRenderedPages(requireCallToolResult(result), requestedPages);
				pagesRendered += renderedPages.length;
				onProgress?.({ stage: "render", pagesRendered, pagesToRender: damagedPages.length });
				return renderedPages;
			}),
		);
		return { pageCount, pages, damagedPages, renders: renderResults.flat() };
	} finally {
		await client.close();
	}
}

export function formatNativePdfPages(extraction: SystemPdfExtraction): string {
	return extraction.pages
		.map(
			(page) =>
				`## Page ${page.page}${page.damaged ? " (native text damaged; corresponding image attached)" : ""}\n\n${page.text}`,
		)
		.join("\n\n");
}
