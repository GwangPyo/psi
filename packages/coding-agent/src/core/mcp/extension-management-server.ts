import { type Static, Type } from "typebox";
import type { ExtensionManagementResult, ExtensionManager } from "../extension-manager.ts";

export const EXTENSION_MANAGEMENT_MCP_PROTOCOL_VERSION = "2025-11-25";

export const ManageExtensionParameters = Type.Object({
	action: Type.Union([
		Type.Literal("search"),
		Type.Literal("add"),
		Type.Literal("remove"),
		Type.Literal("list"),
		Type.Literal("status"),
	]),
	query: Type.Optional(Type.String({ description: "Search text for the search action" })),
	source: Type.Optional(Type.String({ description: "npm, git, or local extension package source" })),
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("all")])),
	reason: Type.Optional(Type.String({ description: "Why the extension operation is needed" })),
});

export type ManageExtensionInput = Static<typeof ManageExtensionParameters>;

export interface ExtensionManagementMcpContext {
	createManager(): ExtensionManager;
}

type JsonRpcId = string | number;

export type ExtensionManagementMcpRequest =
	| {
			jsonrpc: "2.0";
			id: JsonRpcId;
			method: "initialize";
			params: {
				protocolVersion: string;
				capabilities: Record<string, unknown>;
				clientInfo: { name: string; version: string };
			};
	  }
	| { jsonrpc: "2.0"; id: JsonRpcId; method: "tools/list"; params?: { cursor?: string } }
	| {
			jsonrpc: "2.0";
			id: JsonRpcId;
			method: "tools/call";
			params: { name: string; arguments?: Record<string, unknown> };
	  };

export type ExtensionManagementMcpResponse =
	| { jsonrpc: "2.0"; id: JsonRpcId; result: Record<string, unknown> }
	| { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

function isManageExtensionInput(value: Record<string, unknown>): value is ManageExtensionInput {
	const action = value.action;
	if (!["search", "add", "remove", "list", "status"].includes(typeof action === "string" ? action : "")) return false;
	if (value.query !== undefined && typeof value.query !== "string") return false;
	if (value.source !== undefined && typeof value.source !== "string") return false;
	if (value.reason !== undefined && typeof value.reason !== "string") return false;
	return value.scope === undefined || value.scope === "user" || value.scope === "project" || value.scope === "all";
}

export class ExtensionManagementMcpServer {
	async handle(
		request: ExtensionManagementMcpRequest,
		context: ExtensionManagementMcpContext,
	): Promise<ExtensionManagementMcpResponse> {
		if (request.method === "initialize") {
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					protocolVersion: EXTENSION_MANAGEMENT_MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "pi-extension-management", version: "1.0.0" },
				},
			};
		}

		if (request.method === "tools/list") {
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					tools: [
						{
							name: "manage_extension",
							title: "Manage Pi Extensions",
							description:
								"Search, add, remove, list, or inspect Pi extension packages. Use add and remove only when the user explicitly requests a persistent extension change.",
							inputSchema: ManageExtensionParameters,
						},
					],
				},
			};
		}

		if (request.params.name !== "manage_extension") {
			return {
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32602, message: `Unknown tool: ${request.params.name}` },
			};
		}

		const args = request.params.arguments ?? {};
		if (!isManageExtensionInput(args)) {
			return {
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32602, message: "Invalid manage_extension arguments" },
			};
		}

		const result = await context.createManager().execute({
			...args,
			requestedBy: "model-mcp",
		});
		return {
			jsonrpc: "2.0",
			id: request.id,
			result: {
				content: [{ type: "text", text: result.message }],
				structuredContent: result,
				isError: result.status === "failed",
			},
		};
	}
}

export class InProcessExtensionManagementMcpClient {
	private readonly server: ExtensionManagementMcpServer;
	private initialized = false;
	private nextId = 1;

	constructor(server: ExtensionManagementMcpServer) {
		this.server = server;
	}

	async callTool(
		input: ManageExtensionInput,
		context: ExtensionManagementMcpContext,
	): Promise<ExtensionManagementResult> {
		if (!this.initialized) {
			const initializeResponse = await this.server.handle(
				{
					jsonrpc: "2.0",
					id: this.nextId++,
					method: "initialize",
					params: {
						protocolVersion: EXTENSION_MANAGEMENT_MCP_PROTOCOL_VERSION,
						capabilities: {},
						clientInfo: { name: "pi-coding-agent", version: "1.0.0" },
					},
				},
				context,
			);
			if ("error" in initializeResponse) throw new Error(initializeResponse.error.message);
			const listResponse = await this.server.handle(
				{ jsonrpc: "2.0", id: this.nextId++, method: "tools/list" },
				context,
			);
			if ("error" in listResponse) throw new Error(listResponse.error.message);
			const tools = listResponse.result.tools;
			if (
				!Array.isArray(tools) ||
				!tools.some(
					(tool) =>
						typeof tool === "object" && tool !== null && "name" in tool && tool.name === "manage_extension",
				)
			) {
				throw new Error("MCP server did not advertise manage_extension");
			}
			this.initialized = true;
		}

		const response = await this.server.handle(
			{
				jsonrpc: "2.0",
				id: this.nextId++,
				method: "tools/call",
				params: { name: "manage_extension", arguments: input },
			},
			context,
		);
		if ("error" in response) throw new Error(response.error.message);
		return response.result.structuredContent as unknown as ExtensionManagementResult;
	}
}
