import { spawnProcess } from "../utils/child-process.ts";
import type { SettingsManager } from "./settings-manager.ts";

const SEARCH_TIMEOUT_MS = 10_000;

export interface ExtensionCatalogCandidate {
	source: string;
	name: string;
	version: string;
	description?: string;
	keywords: string[];
}

export interface ExtensionCatalog {
	search(query: string): Promise<ExtensionCatalogCandidate[]>;
}

export interface ExtensionCatalogCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export type ExtensionCatalogCommandRunner = (
	command: string,
	args: string[],
	timeoutMs: number,
) => Promise<ExtensionCatalogCommandResult>;

interface NpmSearchResult {
	name?: unknown;
	version?: unknown;
	description?: unknown;
	keywords?: unknown;
}

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function parseCandidate(value: NpmSearchResult): ExtensionCatalogCandidate | undefined {
	if (typeof value.name !== "string" || typeof value.version !== "string") return undefined;
	const keywords = Array.isArray(value.keywords)
		? value.keywords.filter((keyword): keyword is string => typeof keyword === "string")
		: [];
	if (!keywords.includes("pi-package")) return undefined;
	return {
		source: `npm:${value.name}@${value.version}`,
		name: value.name,
		version: value.version,
		description: typeof value.description === "string" ? value.description : undefined,
		keywords,
	};
}

async function readOutput(stream: NodeJS.ReadableStream): Promise<string> {
	let output = "";
	stream.setEncoding("utf8");
	for await (const chunk of stream) output += String(chunk);
	return output;
}

async function runCatalogCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<ExtensionCatalogCommandResult> {
	const child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	const stdoutPromise = readOutput(child.stdout);
	const stderrPromise = readOutput(child.stderr);
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	const exitCodePromise = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const [exitCode, stdout, stderr] = await Promise.all([exitCodePromise, stdoutPromise, stderrPromise]).finally(() =>
		clearTimeout(timeout),
	);
	if (timedOut) throw new Error(`Extension catalog search timed out after ${timeoutMs}ms`);
	return { exitCode, stdout, stderr };
}

export class NpmExtensionCatalog implements ExtensionCatalog {
	private readonly commandRunner: ExtensionCatalogCommandRunner;
	private readonly settingsManager: SettingsManager;

	constructor(settingsManager: SettingsManager, commandRunner: ExtensionCatalogCommandRunner = runCatalogCommand) {
		this.settingsManager = settingsManager;
		this.commandRunner = commandRunner;
	}

	async search(query: string): Promise<ExtensionCatalogCandidate[]> {
		if (isOfflineModeEnabled()) return [];
		const configuredCommand = this.settingsManager.getNpmCommand() ?? ["npm"];
		const [command, ...commandArgs] = configuredCommand;
		if (!command?.trim()) throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		const searchTerms = ["pi-package"];
		if (query.trim()) searchTerms.push(query.trim());

		const { exitCode, stdout, stderr } = await this.commandRunner(
			command,
			[...commandArgs, "search", "--json", "--searchlimit=20", ...searchTerms],
			SEARCH_TIMEOUT_MS,
		);
		if (exitCode !== 0) throw new Error(stderr.trim() || `npm search failed with code ${exitCode}`);

		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Invalid npm search response: ${detail} (stdout bytes: ${Buffer.byteLength(stdout)}, stderr: ${stderr.trim() || "empty"})`,
			);
		}
		if (!Array.isArray(parsed)) throw new Error("Invalid npm search response: expected an array");
		return parsed
			.map((value) => parseCandidate(value as NpmSearchResult))
			.filter((candidate): candidate is ExtensionCatalogCandidate => candidate !== undefined)
			.sort((left, right) => left.name.localeCompare(right.name));
	}
}
