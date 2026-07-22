import { getAgentDir } from "../../config.ts";
import { type ExtensionManagementResult, ExtensionManager } from "../../core/extension-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	ExtensionManagementMcpServer,
	InProcessExtensionManagementMcpClient,
	type ManageExtensionInput,
	ManageExtensionParameters,
} from "../../core/mcp/extension-management-server.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

function createManager(ctx: ExtensionContext): ExtensionManager {
	return new ExtensionManager({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager: SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}),
	});
}

function shouldReload(result: ExtensionManagementResult): boolean {
	return result.status === "completed" && result.changed && result.reloadRequired;
}

export default function extensionManagerExtension(pi: ExtensionAPI): void {
	const mcpClient = new InProcessExtensionManagementMcpClient(new ExtensionManagementMcpServer());

	pi.registerTool({
		name: "manage_extension",
		label: "Manage Extension",
		description:
			"Search, add, remove, list, or inspect Pi extension packages through the built-in MCP server. Use add and remove only when the user explicitly requests a persistent extension change. After a successful mutation, stop the current work while Pi reloads its resources.",
		promptSnippet: "Manage persistent Pi extension packages through MCP",
		promptGuidelines: [
			"Use manage_extension when the user asks to add, remove, list, search, or inspect Pi extension packages.",
			"For add and remove, use an exact source and explain the requested persistent change in reason.",
		],
		parameters: ManageExtensionParameters,
		executionMode: "sequential",
		async execute(_toolCallId, input: ManageExtensionInput, _signal, _onUpdate, ctx) {
			if ((input.action === "add" || input.action === "remove") && ctx.hasUI) {
				const approved = await ctx.ui.confirm(
					`${input.action === "add" ? "Add" : "Remove"} extension package?`,
					`${input.source ?? "Missing source"}\nScope: ${input.scope ?? "missing"}`,
				);
				if (!approved) {
					return {
						content: [{ type: "text", text: "The user cancelled the extension package change." }],
						details: { cancelled: true },
					};
				}
			}

			const result = await mcpClient.callTool(input, { createManager: () => createManager(ctx) });
			if (shouldReload(result)) {
				pi.sendUserMessage("/reload", { deliverAs: "followUp" });
			}
			return {
				content: [
					{
						type: "text",
						text: shouldReload(result) ? `${result.message}\nQueued runtime reload.` : result.message,
					},
				],
				details: result,
				isError: result.status === "failed",
			};
		},
	});
}
