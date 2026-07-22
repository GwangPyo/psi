import { randomUUID } from "node:crypto";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import { type ExtensionCatalog, type ExtensionCatalogCandidate, NpmExtensionCatalog } from "./extension-catalog.ts";
import { type ConfiguredPackage, DefaultPackageManager, type ProgressCallback } from "./package-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

export type ExtensionManagementAction = "search" | "add" | "remove" | "list" | "status";
export type ExtensionManagementScope = "user" | "project";
export type ExtensionManagementListScope = ExtensionManagementScope | "all";
export type ExtensionManagementRequester = "slash-command" | "model-mcp";

export interface ExtensionManagementRequest {
	action: ExtensionManagementAction;
	source?: string;
	query?: string;
	scope?: ExtensionManagementListScope;
	requestedBy: ExtensionManagementRequester;
	reason?: string;
}

export interface ExtensionPackageInfo extends ConfiguredPackage {
	installed: boolean;
}

export interface ExtensionManagementResult {
	operationId: string;
	action: ExtensionManagementAction;
	status: "completed" | "failed";
	changed: boolean;
	reloadRequired: boolean;
	message: string;
	packages: ExtensionPackageInfo[];
	candidates?: ExtensionCatalogCandidate[];
	error?: {
		code: string;
		detail: string;
	};
}

export interface ExtensionManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	onProgress?: ProgressCallback;
	catalog?: ExtensionCatalog;
}

function packageInfo(pkg: ConfiguredPackage): ExtensionPackageInfo {
	return { ...pkg, installed: pkg.installedPath !== undefined };
}

function packageListsEqual(left: ExtensionPackageInfo[], right: ExtensionPackageInfo[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function formatPackage(pkg: ExtensionPackageInfo): string {
	const location = pkg.installedPath ?? "missing";
	return `${pkg.source} (${pkg.scope}, ${location})`;
}

export class ExtensionManager {
	private readonly cwd: string;
	private readonly catalog: ExtensionCatalog;
	private readonly packageManager: DefaultPackageManager;
	private readonly settingsManager: SettingsManager;
	private operationQueue: Promise<void> = Promise.resolve();

	constructor(options: ExtensionManagerOptions) {
		this.cwd = options.cwd;
		this.settingsManager = options.settingsManager;
		this.catalog = options.catalog ?? new NpmExtensionCatalog(options.settingsManager);
		this.packageManager = new DefaultPackageManager({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager,
		});
		this.packageManager.setProgressCallback(options.onProgress);
	}

	async execute(request: ExtensionManagementRequest): Promise<ExtensionManagementResult> {
		const previous = this.operationQueue;
		let release: (() => void) | undefined;
		this.operationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		try {
			return await this.executeUnlocked(request);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return {
				operationId: randomUUID(),
				action: request.action,
				status: "failed",
				changed: false,
				reloadRequired: false,
				message: detail,
				packages: [],
				error: { code: "extension_operation_failed", detail },
			};
		} finally {
			release?.();
		}
	}

	private async executeUnlocked(request: ExtensionManagementRequest): Promise<ExtensionManagementResult> {
		switch (request.action) {
			case "search":
				return this.search(request);
			case "list":
				return this.list(request);
			case "status":
				return this.status(request);
			case "add":
				return this.add(request);
			case "remove":
				return this.remove(request);
		}
	}

	private getPackages(scope: ExtensionManagementListScope = "all"): ExtensionPackageInfo[] {
		return this.packageManager
			.listConfiguredPackages()
			.filter((pkg) => scope === "all" || pkg.scope === scope)
			.map(packageInfo)
			.sort((left, right) => left.source.localeCompare(right.source));
	}

	private async search(request: ExtensionManagementRequest): Promise<ExtensionManagementResult> {
		const query = request.query?.trim();
		if (!query) return this.invalid(request.action, "search requires a query", "missing_query");
		const normalizedQuery = query.toLowerCase();
		const packages = this.getPackages(request.scope ?? "all").filter((pkg) =>
			pkg.source.toLowerCase().includes(normalizedQuery),
		);
		const candidates = await this.catalog.search(query);
		const configuredMessage = packages.map(formatPackage);
		const catalogMessage = candidates.map(
			(candidate) => `${candidate.source}${candidate.description ? ` — ${candidate.description}` : ""}`,
		);
		return this.success(
			request.action,
			false,
			false,
			configuredMessage.length + catalogMessage.length > 0
				? [...configuredMessage, ...catalogMessage].join("\n")
				: `No extension packages match "${query}".`,
			packages,
			candidates,
		);
	}

	private list(request: ExtensionManagementRequest): ExtensionManagementResult {
		const packages = this.getPackages(request.scope ?? "all");
		return this.success(
			request.action,
			false,
			false,
			packages.length > 0 ? packages.map(formatPackage).join("\n") : "No extension packages are configured.",
			packages,
		);
	}

	private status(request: ExtensionManagementRequest): ExtensionManagementResult {
		const source = request.source?.trim();
		if (!source) return this.invalid(request.action, "status requires a source", "missing_source");
		const packages = this.getPackages(request.scope ?? "all").filter((pkg) => this.matchesSource(pkg, source));
		return this.success(
			request.action,
			false,
			false,
			packages.length > 0
				? packages.map(formatPackage).join("\n")
				: `Extension package is not configured: ${source}`,
			packages,
		);
	}

	private async add(request: ExtensionManagementRequest): Promise<ExtensionManagementResult> {
		const source = request.source?.trim();
		if (!source) return this.invalid(request.action, "add requires a source", "missing_source");
		const scope = this.requireMutationScope(request);
		if (!scope) return this.invalid(request.action, "add requires user or project scope", "invalid_scope");

		const before = this.getPackages("all");
		await this.packageManager.installAndPersist(source, { local: scope === "project" });
		await this.settingsManager.flush();
		const after = this.getPackages("all");
		const changed = !packageListsEqual(before, after);
		const packages = after.filter(
			(pkg) => !before.some((previous) => previous.source === pkg.source && previous.scope === pkg.scope),
		);
		return this.success(
			request.action,
			changed,
			changed,
			changed ? `Installed ${source} in ${scope} scope.` : `${source} is already configured in ${scope} scope.`,
			packages,
		);
	}

	private async remove(request: ExtensionManagementRequest): Promise<ExtensionManagementResult> {
		const source = request.source?.trim();
		if (!source) return this.invalid(request.action, "remove requires a source", "missing_source");
		const scope = this.requireMutationScope(request);
		if (!scope) return this.invalid(request.action, "remove requires user or project scope", "invalid_scope");

		const before = this.getPackages("all");
		const removed = await this.packageManager.removeAndPersist(source, { local: scope === "project" });
		await this.settingsManager.flush();
		if (!removed) {
			return this.invalid(request.action, `No matching extension package found: ${source}`, "package_not_found");
		}
		const after = this.getPackages("all");
		const packages = before.filter(
			(pkg) => !after.some((next) => next.source === pkg.source && next.scope === pkg.scope),
		);
		return this.success(request.action, true, true, `Removed ${source} from ${scope} scope.`, packages);
	}

	private requireMutationScope(request: ExtensionManagementRequest): ExtensionManagementScope | undefined {
		return request.scope === "user" || request.scope === "project" ? request.scope : undefined;
	}

	private matchesSource(pkg: ExtensionPackageInfo, source: string): boolean {
		if (pkg.source === source) return true;
		return isLocalPath(source) && pkg.installedPath === resolvePath(source, this.cwd);
	}

	private success(
		action: ExtensionManagementAction,
		changed: boolean,
		reloadRequired: boolean,
		message: string,
		packages: ExtensionPackageInfo[],
		candidates?: ExtensionCatalogCandidate[],
	): ExtensionManagementResult {
		return {
			operationId: randomUUID(),
			action,
			status: "completed",
			changed,
			reloadRequired,
			message,
			packages,
			candidates,
		};
	}

	private invalid(action: ExtensionManagementAction, detail: string, code: string): ExtensionManagementResult {
		return {
			operationId: randomUUID(),
			action,
			status: "failed",
			changed: false,
			reloadRequired: false,
			message: detail,
			packages: [],
			error: { code, detail },
		};
	}
}
