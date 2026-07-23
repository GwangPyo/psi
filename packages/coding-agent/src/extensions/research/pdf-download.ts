import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResearchWorkspace } from "./workspace.ts";

const MAX_PDF_BYTES = 100 * 1024 * 1024;

export interface PdfDownloadRequest {
	url: string;
	title?: string;
	landingPageUrl?: string;
}

export interface PdfDownloadResult extends PdfDownloadRequest {
	path?: string;
	bytes?: number;
	error?: string;
}

function pdfFileName(request: PdfDownloadRequest): string {
	const url = new URL(request.url);
	const urlStem = path.basename(decodeURIComponent(url.pathname)).replace(/\.pdf$/i, "");
	const stem = (request.title || urlStem || "paper")
		.normalize("NFKD")
		.replace(/[^a-zA-Z0-9가-힣._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	const identity = createHash("sha256").update(request.url).digest("hex").slice(0, 10);
	return `${stem || "paper"}-${identity}.pdf`;
}

async function readResponseBody(response: Response): Promise<Buffer> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
		throw new Error(`PDF exceeds ${MAX_PDF_BYTES} bytes`);
	}
	if (!response.body) throw new Error("PDF response has no body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > MAX_PDF_BYTES) {
			await reader.cancel();
			throw new Error(`PDF exceeds ${MAX_PDF_BYTES} bytes`);
		}
		chunks.push(chunk.value);
	}
	return Buffer.concat(chunks);
}

async function downloadOne(
	cwd: string,
	destinationDirectory: string,
	request: PdfDownloadRequest,
	signal?: AbortSignal,
): Promise<PdfDownloadResult> {
	const requestedUrl = new URL(request.url);
	if (requestedUrl.protocol !== "https:") throw new Error("Only HTTPS PDF URLs are allowed");
	const fileName = pdfFileName(request);
	const destination = path.join(destinationDirectory, fileName);
	const relativeDestination = path.relative(cwd, destination);
	const existing = await fs.promises.stat(destination).catch(() => undefined);
	if (existing?.isFile()) return { ...request, path: relativeDestination, bytes: existing.size };

	const response = await fetch(requestedUrl, {
		redirect: "follow",
		signal,
		headers: { accept: "application/pdf", "user-agent": "pi-research/1.0" },
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	if (new URL(response.url || request.url).protocol !== "https:") throw new Error("PDF redirect left HTTPS");
	const body = await readResponseBody(response);
	if (body.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Downloaded response is not a PDF");

	const temporary = path.join(destinationDirectory, `.${fileName}.${randomUUID()}.tmp`);
	await fs.promises.writeFile(temporary, body, { flag: "wx" });
	try {
		await fs.promises.rename(temporary, destination);
	} catch (error) {
		await fs.promises.rm(temporary, { force: true });
		throw error;
	}
	return { ...request, path: relativeDestination, bytes: body.byteLength };
}

export async function downloadResearchPdfs(
	cwd: string,
	workspace: ResearchWorkspace,
	requests: readonly PdfDownloadRequest[],
	signal?: AbortSignal,
): Promise<PdfDownloadResult[]> {
	return downloadPdfsToDirectory(cwd, path.join(workspace.absolutePath, "papers"), requests, signal);
}

export async function downloadPdfsToDirectory(
	cwd: string,
	destinationDirectory: string,
	requests: readonly PdfDownloadRequest[],
	signal?: AbortSignal,
): Promise<PdfDownloadResult[]> {
	await fs.promises.mkdir(destinationDirectory, { recursive: true });
	return await Promise.all(
		requests.map(async (request) => {
			try {
				return await downloadOne(cwd, destinationDirectory, request, signal);
			} catch (error) {
				return { ...request, error: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
}

export async function promoteResearchPdf(
	cwd: string,
	workspace: ResearchWorkspace,
	temporaryPdfPath: string,
	request: PdfDownloadRequest,
): Promise<string> {
	const destinationDirectory = path.join(workspace.absolutePath, "papers");
	await fs.promises.mkdir(destinationDirectory, { recursive: true });
	const destination = path.join(destinationDirectory, pdfFileName(request));
	const existing = await fs.promises.stat(destination).catch(() => undefined);
	if (!existing?.isFile()) {
		const stagedDestination = `${destination}.${randomUUID()}.tmp`;
		await fs.promises.copyFile(temporaryPdfPath, stagedDestination, fs.constants.COPYFILE_EXCL);
		try {
			await fs.promises.rename(stagedDestination, destination);
		} catch (error) {
			await fs.promises.rm(stagedDestination, { force: true });
			throw error;
		}
	}
	return path.relative(cwd, destination);
}
