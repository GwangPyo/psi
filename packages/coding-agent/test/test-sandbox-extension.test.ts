import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import {
	IsolatedTestRunner,
	TEST_SANDBOX_MCP_PROTOCOL_VERSION,
	type TestInput,
	type TestResult,
	TestSandboxMcpServer,
} from "../src/core/mcp/test-sandbox-server.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import {
	createTestSandboxExtension,
	isAdHocProjectTestPath,
	isTestCommand,
	type TestSandboxClient,
} from "../src/extensions/test-sandbox/index.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function result(overrides: Partial<TestResult> = {}): TestResult {
	return {
		status: "passed",
		exitCode: 0,
		output: "ok\n",
		outputTruncated: false,
		projectRoot: "/project",
		workingDirectory: "/project",
		scratchDirectory: "/tmp/pi-test-example",
		scratchRemoved: true,
		copiedBytes: 0,
		...overrides,
	};
}

interface RegisteredTestTool {
	execute(
		toolCallId: string,
		input: TestInput,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<{ content: Array<{ type: string; text: string }>; details?: TestResult; isError?: boolean }>;
}

function extensionHarness(testResult = result()) {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	let tool: RegisteredTestTool | undefined;
	const client: TestSandboxClient = {
		callTool: vi.fn(async () => testResult),
	};
	const api = {
		registerTool(definition: ToolDefinition) {
			tool = definition as unknown as RegisteredTestTool;
		},
		on(event: string, handler: (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	createTestSandboxExtension({ client })(api);
	const context = { cwd: "/project" } as ExtensionContext;

	return {
		client,
		context,
		getTool(): RegisteredTestTool {
			if (!tool) throw new Error("test tool was not registered");
			return tool;
		},
		async emit(event: string, payload: unknown): Promise<unknown> {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`Missing ${event} handler`);
			return await handler(payload as never, context);
		},
	};
}

describe("test sandbox MCP", () => {
	it("advertises and calls the test tool through MCP", async () => {
		const server = new TestSandboxMcpServer();
		const context = { run: vi.fn(async () => result()) };
		const initialized = await server.handle(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: TEST_SANDBOX_MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "test-client", version: "1.0.0" },
				},
			},
			context,
		);
		expect("result" in initialized && initialized.result.protocolVersion).toBe(TEST_SANDBOX_MCP_PROTOCOL_VERSION);

		const tools = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, context);
		expect("result" in tools && tools.result.tools).toEqual([expect.objectContaining({ name: "test" })]);

		const called = await server.handle(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "test", arguments: { command: "true" } },
			},
			context,
		);
		expect(context.run).toHaveBeenCalledWith({ command: "true" });
		expect("result" in called && called.result.structuredContent).toEqual(
			expect.objectContaining({ copiedBytes: 0, scratchRemoved: true, status: "passed" }),
		);
	});

	it.runIf(process.platform === "linux" && existsSync("/usr/bin/bwrap"))(
		"reads the project in place, writes only to scratch, and copies no project data",
		async () => {
			const projectRoot = mkdtempSync(join(tmpdir(), "pi-test-project-"));
			temporaryRoots.push(projectRoot);
			writeFileSync(join(projectRoot, "source.txt"), "project source");
			const runner = new IsolatedTestRunner(projectRoot);

			const run = await runner.run({
				command:
					'test -r "$PI_TEST_PROJECT_ROOT/source.txt" && test -r "$PI_TEST_SCRATCH/probes/check.txt" && printf "generated" > "$PI_TEST_SCRATCH/output.txt" && printf "passed\\n"',
				files: [{ path: "probes/check.txt", content: "fixture" }],
			});

			expect(run).toEqual(
				expect.objectContaining({
					status: "passed",
					exitCode: 0,
					output: "passed\n",
					copiedBytes: 0,
					scratchRemoved: true,
				}),
			);
			expect(existsSync(run.scratchDirectory)).toBe(false);
			expect(existsSync(join(projectRoot, "output.txt"))).toBe(false);
		},
	);

	it.runIf(process.platform === "linux" && existsSync("/usr/bin/bwrap"))(
		"rejects writes to the original project",
		async () => {
			const projectRoot = mkdtempSync(join(tmpdir(), "pi-test-project-"));
			temporaryRoots.push(projectRoot);
			mkdirSync(join(projectRoot, "data"));
			const runner = new IsolatedTestRunner(projectRoot);

			const run = await runner.run({
				command: 'printf "polluted" > "$PI_TEST_PROJECT_ROOT/data/polluted.txt"',
			});

			expect(run.status).toBe("failed");
			expect(run.exitCode).not.toBe(0);
			expect(existsSync(join(projectRoot, "data", "polluted.txt"))).toBe(false);
		},
	);

	it("rejects dynamic-loader overrides before launching the sandbox", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "pi-test-project-"));
		temporaryRoots.push(projectRoot);
		const runner = new IsolatedTestRunner(projectRoot);

		await expect(runner.run({ command: "true", env: { LD_PRELOAD: "/tmp/escape.so" } })).rejects.toThrow(
			"cannot override sandbox launcher variable LD_PRELOAD",
		);
	});
});

describe("test sandbox extension", () => {
	it("is a hidden built-in extension", () => {
		expect(builtInExtensions).toContainEqual(expect.objectContaining({ name: "test-sandbox", hidden: true }));
	});

	it("routes test execution through the MCP client", async () => {
		const harness = extensionHarness();
		const response = await harness
			.getTool()
			.execute(
				"call-1",
				{ command: "vitest --run", files: [{ path: "probe.test.ts", content: "test code" }] },
				undefined,
				undefined,
				harness.context,
			);

		expect(harness.client.callTool).toHaveBeenCalledWith(
			{ command: "vitest --run", files: [{ path: "probe.test.ts", content: "test code" }] },
			expect.objectContaining({ run: expect.any(Function) }),
		);
		expect(response).toEqual(
			expect.objectContaining({ isError: false, details: expect.objectContaining({ copiedBytes: 0 }) }),
		);
	});

	it("injects the mandatory scratch policy before each agent run", async () => {
		const harness = extensionHarness();
		const response = (await harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "test it",
			systemPrompt: "base",
			systemPromptOptions: { cwd: "/project" },
		} satisfies BeforeAgentStartEvent)) as { systemPrompt: string };

		expect(response.systemPrompt).toContain(
			"All test runner commands and ad-hoc verification scripts must use the test tool.",
		);
		expect(response.systemPrompt).toContain("without copying it");
	});

	it.each([
		"npm test",
		"cd packages/agent && pnpm run test:unit",
		"FOO=bar pytest -q",
		"cargo nextest run",
		"go test ./...",
		"node --test test/example.test.js",
		"./test.sh",
	])("blocks direct test execution through bash: %s", async (command) => {
		const harness = extensionHarness();
		const response = (await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "bash",
			input: { command },
		} satisfies ToolCallEvent)) as ToolCallEventResult;

		expect(response).toEqual(
			expect.objectContaining({
				block: true,
				reason: expect.stringContaining("Use the test tool"),
			}),
		);
	});

	it.each(["rg 'npm test' README.md", "printf 'pytest is documented\\n'", "npm run lint", "cargo check"])(
		"does not block non-test shell commands: %s",
		async (command) => {
			expect(isTestCommand(command)).toBe(false);
			const harness = extensionHarness();
			await expect(
				harness.emit("tool_call", {
					type: "tool_call",
					toolCallId: "call-1",
					toolName: "bash",
					input: { command },
				} satisfies ToolCallEvent),
			).resolves.toBeUndefined();
		},
	);

	it.each(["scratch.py", "quick-test.ts", "tools/repro_bug.js", "probe.rs", "debug.spec.ts", "test.py"])(
		"blocks a new ad-hoc test file in the project: %s",
		async (path) => {
			expect(isAdHocProjectTestPath(path, "/project")).toBe(true);
			const harness = extensionHarness();
			const response = await harness.emit("tool_call", {
				type: "tool_call",
				toolCallId: "call-1",
				toolName: "write",
				input: { path, content: "temporary test" },
			} satisfies ToolCallEvent);

			expect(response).toEqual(
				expect.objectContaining({
					block: true,
					reason: expect.stringContaining("test.files"),
				}),
			);
		},
	);

	it.each(["tests/new-feature.test.ts", "test/unit/test_feature.py", "src/contest.ts", "/tmp/repro.py"])(
		"allows permanent test-suite files and paths outside the project: %s",
		async (path) => {
			expect(isAdHocProjectTestPath(path, "/project")).toBe(false);
			const harness = extensionHarness();
			await expect(
				harness.emit("tool_call", {
					type: "tool_call",
					toolCallId: "call-1",
					toolName: "write",
					input: { path, content: "intentional file" },
				} satisfies ToolCallEvent),
			).resolves.toBeUndefined();
		},
	);
});
