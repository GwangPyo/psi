import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { NpmExtensionCatalog } from "../src/core/extension-catalog.ts";
import { ExtensionManager } from "../src/core/extension-manager.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	EXTENSION_MANAGEMENT_MCP_PROTOCOL_VERSION,
	ExtensionManagementMcpServer,
} from "../src/core/mcp/extension-management-server.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import extensionManagerExtension from "../src/extensions/extension-manager/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ManageExtensionCommandContext {
	settingsManager: SettingsManager;
	sessionManager: { getCwd(): string };
	runtimeHost: { services: { agentDir: string } };
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	handleReloadCommand(): Promise<void>;
	showManageExtensionSelector(): Promise<void>;
}

interface ManageExtensionSelectorContext {
	runtimeHost: {
		services: { agentDir: string };
		session: {
			settingsManager: SettingsManager;
			sessionManager: { getCwd(): string };
			resourceLoader: {
				getDefaultExtensions(): Array<{ name: string; enabled: boolean; hidden: boolean }>;
			};
		};
	};
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleManageExtensionCommand(this: ManageExtensionCommandContext, text: string): Promise<void>;
	showManageExtensionSelector(this: ManageExtensionSelectorContext): Promise<void>;
};

describe("extension management", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let extensionPath: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env[ENV_AGENT_DIR];
		tempDir = join(tmpdir(), `extension-management-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		extensionPath = join(tempDir, "local-extension");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(extensionPath, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("adds, lists, searches, reports, and removes a local extension package", async () => {
		const settingsManager = SettingsManager.inMemory();
		const manager = new ExtensionManager({
			cwd,
			agentDir,
			settingsManager,
			catalog: {
				search: async () => [
					{
						source: "npm:@example/pi-local-extension@1.2.3",
						name: "@example/pi-local-extension",
						version: "1.2.3",
						description: "Example extension",
						keywords: ["pi-package"],
					},
				],
			},
		});

		const added = await manager.execute({
			action: "add",
			source: extensionPath,
			scope: "user",
			requestedBy: "slash-command",
		});
		expect(added.status).toBe("completed");
		expect(added.changed).toBe(true);
		expect(added.reloadRequired).toBe(true);

		const listed = await manager.execute({ action: "list", scope: "all", requestedBy: "slash-command" });
		expect(listed.packages).toEqual([
			expect.objectContaining({ installedPath: extensionPath, scope: "user", installed: true }),
		]);

		const searched = await manager.execute({
			action: "search",
			query: "local-extension",
			scope: "all",
			requestedBy: "slash-command",
		});
		expect(searched.packages).toHaveLength(1);
		expect(searched.candidates).toEqual([
			expect.objectContaining({ source: "npm:@example/pi-local-extension@1.2.3" }),
		]);

		const status = await manager.execute({
			action: "status",
			source: extensionPath,
			scope: "all",
			requestedBy: "slash-command",
		});
		expect(status.packages).toHaveLength(1);

		const removed = await manager.execute({
			action: "remove",
			source: extensionPath,
			scope: "user",
			requestedBy: "slash-command",
		});
		expect(removed.status).toBe("completed");
		expect(removed.changed).toBe(true);
		expect(settingsManager.getPackages()).toEqual([]);
	});

	it("rejects project mutation when project trust is disabled", async () => {
		const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
		const manager = new ExtensionManager({ cwd, agentDir, settingsManager });
		const result = await manager.execute({
			action: "add",
			source: extensionPath,
			scope: "project",
			requestedBy: "model-mcp",
		});

		expect(result.status).toBe("failed");
		expect(result.error?.code).toBe("extension_operation_failed");
		expect(result.message).toContain("Project is not trusted");
	});

	it("serves the management tool over process-local MCP", async () => {
		const settingsManager = SettingsManager.inMemory({ packages: [extensionPath] });
		const manager = new ExtensionManager({ cwd, agentDir, settingsManager });
		const server = new ExtensionManagementMcpServer();
		const context = { createManager: () => manager };

		const initialized = await server.handle(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: EXTENSION_MANAGEMENT_MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "test-client", version: "1.0.0" },
				},
			},
			context,
		);
		expect("result" in initialized && initialized.result.protocolVersion).toBe(
			EXTENSION_MANAGEMENT_MCP_PROTOCOL_VERSION,
		);

		const tools = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, context);
		expect("result" in tools && tools.result.tools).toEqual([expect.objectContaining({ name: "manage_extension" })]);

		const called = await server.handle(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "manage_extension", arguments: { action: "list", scope: "all" } },
			},
			context,
		);
		expect("result" in called && called.result.isError).toBe(false);
		expect("result" in called && called.result.structuredContent).toEqual(
			expect.objectContaining({ action: "list", status: "completed" }),
		);
	});

	it("searches npm metadata and keeps pi-package candidates", async () => {
		const settingsManager = SettingsManager.inMemory({ npmCommand: ["custom-npm", "--profile", "pi"] });
		const commandRunner = vi.fn(async () => ({
			exitCode: 0,
			stdout: JSON.stringify([
				{ name: "pi-example", version: "2.0.0", description: "Pi extension", keywords: ["pi-package"] },
				{ name: "other", version: "1.0.0", keywords: ["unrelated"] },
			]),
			stderr: "",
		}));
		const catalog = new NpmExtensionCatalog(settingsManager, commandRunner);

		await expect(catalog.search("example")).resolves.toEqual([
			{
				source: "npm:pi-example@2.0.0",
				name: "pi-example",
				version: "2.0.0",
				description: "Pi extension",
				keywords: ["pi-package"],
			},
		]);
		expect(commandRunner).toHaveBeenCalledWith(
			"custom-npm",
			["--profile", "pi", "search", "--json", "--searchlimit=20", "pi-package", "example"],
			10_000,
		);

		commandRunner.mockClear();
		await catalog.search("");
		expect(commandRunner).toHaveBeenCalledWith(
			"custom-npm",
			["--profile", "pi", "search", "--json", "--searchlimit=20", "pi-package"],
			10_000,
		);
	});

	it("registers the core slash command and model tool", async () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual(expect.objectContaining({ name: "manage_extension" }));

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			extensionFactories: [{ name: "extension-manager", factory: extensionManagerExtension, hidden: true }],
		});
		await resourceLoader.reload();
		const extension = resourceLoader
			.getExtensions()
			.extensions.find((candidate) => candidate.path.includes("extension-manager"));
		expect(extension?.commands.size).toBe(0);
		expect(extension?.tools.has("manage_extension")).toBe(true);
	});

	it("loads plan as a manageable default extension", async () => {
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: builtInExtensions,
		});

		await resourceLoader.reload();

		expect(resourceLoader.getDefaultExtensions()).toContainEqual({
			name: "plan",
			enabled: true,
			hidden: false,
		});
		expect(resourceLoader.getExtensions().extensions).toContainEqual(
			expect.objectContaining({ path: "<inline:plan>" }),
		);

		settingsManager.setDefaultExtensionEnabled("plan", false);
		await resourceLoader.reload();

		expect(resourceLoader.getDefaultExtensions()).toContainEqual({
			name: "plan",
			enabled: false,
			hidden: false,
		});
		expect(resourceLoader.getExtensions().extensions).not.toContainEqual(
			expect.objectContaining({ path: "<inline:plan>" }),
		);
	});

	it("runs add through the built-in slash command and reloads resources", async () => {
		const settingsManager = SettingsManager.inMemory();
		let reloaded = false;
		const context: ManageExtensionCommandContext = {
			settingsManager,
			sessionManager: { getCwd: () => cwd },
			runtimeHost: { services: { agentDir } },
			showStatus: () => {},
			showWarning: () => {},
			showError: () => {},
			handleReloadCommand: async () => {
				reloaded = true;
			},
			showManageExtensionSelector: async () => {},
		};

		await interactiveModePrototype.handleManageExtensionCommand.call(
			context,
			`/manage_extension add ${extensionPath}`,
		);

		expect(settingsManager.getPackages()).toHaveLength(1);
		expect(reloaded).toBe(true);
	});

	it("opens the extension selector when the slash command has no arguments", async () => {
		const showManageExtensionSelector = vi.fn(async () => {});
		const showWarning = vi.fn();
		const context: ManageExtensionCommandContext = {
			settingsManager: SettingsManager.inMemory(),
			sessionManager: { getCwd: () => cwd },
			runtimeHost: { services: { agentDir } },
			showStatus: () => {},
			showWarning,
			showError: () => {},
			handleReloadCommand: async () => {},
			showManageExtensionSelector,
		};

		await interactiveModePrototype.handleManageExtensionCommand.call(context, "/manage_extension");

		expect(showManageExtensionSelector).toHaveBeenCalledOnce();
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("shows active, inactive, and known available extensions without a search step", async () => {
		const discoveredExtension = join(extensionPath, "active.ts");
		writeFileSync(discoveredExtension, "export default function () {}\n");
		const settingsManager = SettingsManager.inMemory({ extensions: [discoveredExtension] }, { projectTrusted: true });
		const showExtensionSelector = vi.fn(
			async (_title: string, _options: string[]): Promise<string | undefined> => undefined,
		);
		const catalogSearch = vi.spyOn(NpmExtensionCatalog.prototype, "search").mockResolvedValue([
			{
				source: "npm:pi-known@1.2.3",
				name: "pi-known",
				version: "1.2.3",
				description: "Known extension",
				keywords: ["pi-package"],
			},
		]);
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: {
				services: { agentDir },
				session: {
					settingsManager,
					sessionManager: { getCwd: () => cwd },
					resourceLoader: {
						getDefaultExtensions: () => [{ name: "plan", enabled: false, hidden: false }],
					},
				},
			},
			showExtensionSelector,
		}) as ManageExtensionSelectorContext;

		await interactiveModePrototype.showManageExtensionSelector.call(context);

		const [, options] = showExtensionSelector.mock.calls[0] ?? [];
		expect(options?.[0]).toContain("[x] local-extension/active.ts");
		expect(options?.[1]).toBe("[ ] plan · default");
		expect(options?.[2]).toBe("[ ] pi-known@1.2.3 · available · Known extension");
		expect(options).not.toContain("Search available extensions...");
		expect(options).toContain("Add extension from source...");
		expect(catalogSearch).toHaveBeenCalledWith("");
	});

	it("routes a model mutation through MCP and queues the built-in reload command", async () => {
		process.env[ENV_AGENT_DIR] = agentDir;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			extensionFactories: [{ name: "extension-manager", factory: extensionManagerExtension, hidden: true }],
		});
		await resourceLoader.reload();
		const extensionsResult = resourceLoader.getExtensions();
		const tool = extensionsResult.extensions
			.find((candidate) => candidate.path.includes("extension-manager"))
			?.tools.get("manage_extension")?.definition;
		expect(tool).toBeDefined();
		const sendUserMessage = vi.fn();
		extensionsResult.runtime.sendUserMessage = sendUserMessage;
		const ctx = {
			cwd,
			hasUI: false,
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;

		const result = await tool?.execute(
			"tool-call",
			{ action: "add", source: extensionPath, scope: "user", reason: "user requested it" },
			undefined,
			undefined,
			ctx,
		);

		expect(result?.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("Queued runtime reload") }),
		]);
		expect(sendUserMessage).toHaveBeenCalledWith("/reload", { deliverAs: "followUp" });
		expect(SettingsManager.create(cwd, agentDir).getPackages()).toHaveLength(1);
	});
});
