import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import {
	createRmSafetyExtension,
	RM_SAFETY_MESSAGE,
	replaceRecursiveForceRm,
} from "../src/extensions/rm-safety/index.ts";

function extensionHarness() {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	const api = {
		on(event: string, handler: (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	createRmSafetyExtension()(api);
	const context = { cwd: "/project" } as ExtensionContext;

	return {
		async emit(event: string, payload: unknown): Promise<unknown> {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`Missing ${event} handler`);
			return await handler(payload as never, context);
		},
	};
}

describe("rm safety extension", () => {
	it("is the first hidden built-in so later hooks only see the safe command", () => {
		expect(builtInExtensions[0]).toEqual(expect.objectContaining({ name: "rm-safety", hidden: true }));
	});

	it.each([
		["rm -rf target", "rm -r target"],
		["rm -fr target", "rm -r target"],
		["rm -r -f target", "rm -r  target"],
		["rm --force --recursive target", "rm  --recursive target"],
		["sudo -u root /bin/rm -Rfv target", "sudo -u root /bin/rm -Rv target"],
		["mkdir old && rm -rf old; rm --recursive --force other", "mkdir old && rm -r old; rm --recursive  other"],
		["VAR=value command rm '-rf' target", "VAR=value command rm -r target"],
	])("removes force from recursive rm invocations: %s", (command, expected) => {
		expect(replaceRecursiveForceRm(command)).toEqual({ command: expected, replaced: true });
	});

	it.each([
		"rm -f target",
		"rm -r target",
		"rm -- -rf",
		"printf 'rm -rf target\\n'",
		"echo rm -rf target",
		"# rm -rf target\\nprintf safe",
	])("does not rewrite commands without an executable recursive-force rm: %s", (command) => {
		expect(replaceRecursiveForceRm(command)).toEqual({ command, replaced: false });
	});

	it("mutates the bash command before execution and returns the hook message to the agent", async () => {
		const harness = extensionHarness();
		const call = {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "rm -rf target" },
		} satisfies ToolCallEvent;

		await expect(harness.emit("tool_call", call)).resolves.toBeUndefined();
		expect(call.input.command).toBe("rm -r target");

		const result = (await harness.emit("tool_result", {
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "bash",
			input: call.input,
			content: [{ type: "text", text: "command output" }],
			details: undefined,
			isError: false,
		} satisfies ToolResultEvent)) as { content: Array<{ type: string; text: string }> };

		expect(result.content).toEqual([
			{ type: "text", text: RM_SAFETY_MESSAGE },
			{ type: "text", text: "command output" },
		]);
	});

	it("does not add the hook message to unrelated bash results", async () => {
		const harness = extensionHarness();
		await expect(
			harness.emit("tool_result", {
				type: "tool_result",
				toolCallId: "call-2",
				toolName: "bash",
				input: { command: "pwd" },
				content: [{ type: "text", text: "/project" }],
				details: undefined,
				isError: false,
			} satisfies ToolResultEvent),
		).resolves.toBeUndefined();
	});
});
