import * as fs from "node:fs";
import * as path from "node:path";

export const RESEARCH_WORKSPACE_VERSION = 1;

export interface ResearchWorkspaceManifest {
	version: typeof RESEARCH_WORKSPACE_VERSION;
	goal: string;
	createdAt: string;
	updatedAt: string;
}

export interface ResearchSourceRecord {
	url: string;
	title?: string;
	landingPageUrl?: string;
	localPdfPath?: string;
	discoveredAt: string;
}

export interface ResearchWorkspace {
	absolutePath: string;
	relativePath: string;
	manifest: ResearchWorkspaceManifest;
}

function researchRoot(cwd: string): string {
	return path.join(cwd, "research");
}

export async function createResearchWorkspace(cwd: string, goal: string): Promise<ResearchWorkspace> {
	const now = new Date();
	const absolutePath = researchRoot(cwd);
	await Promise.all([
		fs.promises.mkdir(path.join(absolutePath, "papers"), { recursive: true }),
		fs.promises.mkdir(path.join(absolutePath, "evidence"), { recursive: true }),
		fs.promises.mkdir(path.join(absolutePath, "discussions"), { recursive: true }),
	]);
	const existingManifest = await fs.promises
		.readFile(path.join(absolutePath, "manifest.json"), "utf8")
		.then((text) => JSON.parse(text) as ResearchWorkspaceManifest)
		.catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
	const manifest: ResearchWorkspaceManifest = {
		version: RESEARCH_WORKSPACE_VERSION,
		goal,
		createdAt: existingManifest?.createdAt ?? now.toISOString(),
		updatedAt: now.toISOString(),
	};
	await fs.promises.writeFile(path.join(absolutePath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
		encoding: "utf8",
	});
	return { absolutePath, relativePath: path.relative(cwd, absolutePath), manifest };
}

export async function openCurrentResearchWorkspace(cwd: string): Promise<ResearchWorkspace> {
	const absolutePath = researchRoot(cwd);
	const manifestPath = path.join(absolutePath, "manifest.json");
	const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as ResearchWorkspaceManifest;
	if (manifest.version !== RESEARCH_WORKSPACE_VERSION) {
		throw new Error(`Unsupported research workspace manifest: ${manifestPath}`);
	}
	return { absolutePath, relativePath: path.relative(cwd, absolutePath), manifest };
}

export async function appendResearchSources(
	workspace: ResearchWorkspace,
	sources: readonly Omit<ResearchSourceRecord, "discoveredAt">[],
): Promise<number> {
	const sourcesPath = path.join(workspace.absolutePath, "sources.jsonl");
	const existingText = await fs.promises.readFile(sourcesPath, "utf8").catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	});
	const records = new Map(
		existingText
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const record = JSON.parse(line) as ResearchSourceRecord;
				return [record.url, record] as const;
			}),
	);
	const discoveredAt = new Date().toISOString();
	let additions = 0;
	for (const source of sources) {
		const parsedUrl = new URL(source.url);
		if (parsedUrl.protocol !== "https:") throw new Error(`Only HTTPS research sources are allowed: ${source.url}`);
		const existing = records.get(source.url);
		if (!existing) additions++;
		records.set(source.url, {
			...existing,
			...source,
			discoveredAt: existing?.discoveredAt ?? discoveredAt,
		});
	}
	if (sources.length > 0) {
		const serialized = [...records.values()].map((record) => JSON.stringify(record)).join("\n");
		await fs.promises.writeFile(sourcesPath, `${serialized}\n`, "utf8");
	}
	return additions;
}

export async function getResearchWorkspaceStatus(workspace: ResearchWorkspace): Promise<{
	papers: number;
	evidence: number;
	discussions: number;
	sources: number;
}> {
	const countFiles = async (directory: string) =>
		(await fs.promises.readdir(path.join(workspace.absolutePath, directory))).length;
	const [papers, evidence, discussions, sourcesText] = await Promise.all([
		countFiles("papers"),
		countFiles("evidence"),
		countFiles("discussions"),
		fs.promises.readFile(path.join(workspace.absolutePath, "sources.jsonl"), "utf8").catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}),
	]);
	return { papers, evidence, discussions, sources: sourcesText.split("\n").filter(Boolean).length };
}
