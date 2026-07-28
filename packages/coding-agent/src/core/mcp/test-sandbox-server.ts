import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree } from "../../utils/shell.ts";

export const TEST_SANDBOX_MCP_PROTOCOL_VERSION = "2025-11-25";

const MAX_FILES = 32;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const UNSAFE_LAUNCH_ENV = new Set([
	"DYLD_FRAMEWORK_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"LD_AUDIT",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
]);

const TestScratchFileParameters = Type.Object({
	path: Type.String({
		minLength: 1,
		description: "Path relative to PI_TEST_SCRATCH for an ad-hoc test, fixture, or helper",
	}),
	content: Type.String({ maxLength: MAX_FILE_BYTES }),
});

export const TestParameters = Type.Object({
	command: Type.String({
		minLength: 1,
		description:
			"Test command. It runs with the project as cwd and PI_TEST_SCRATCH pointing at the only writable directory.",
	}),
	files: Type.Optional(Type.Array(TestScratchFileParameters, { maxItems: MAX_FILES })),
	projectPath: Type.Optional(
		Type.String({
			description: "Project-relative working directory. Defaults to the active project root.",
		}),
	),
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Additional environment variables. Sandbox path variables cannot be overridden.",
		}),
	),
	timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3600, default: 120 })),
});

export type TestInput = Static<typeof TestParameters>;

export interface TestResult {
	status: "passed" | "failed";
	exitCode: number | null;
	output: string;
	outputTruncated: boolean;
	projectRoot: string;
	workingDirectory: string;
	scratchDirectory: string;
	scratchRemoved: boolean;
	copiedBytes: 0;
}

export interface TestSandboxMcpContext {
	run(input: TestInput): Promise<TestResult>;
}

type JsonRpcId = string | number;

export type TestSandboxMcpRequest =
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

export type TestSandboxMcpResponse =
	| { jsonrpc: "2.0"; id: JsonRpcId; result: Record<string, unknown> }
	| { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

function isTestInput(value: Record<string, unknown>): value is TestInput {
	if (typeof value.command !== "string" || value.command.trim().length === 0) return false;
	if (value.projectPath !== undefined && (typeof value.projectPath !== "string" || isAbsolute(value.projectPath)))
		return false;
	if (value.timeout !== undefined && (typeof value.timeout !== "number" || value.timeout < 1 || value.timeout > 3600))
		return false;
	if (
		value.env !== undefined &&
		(typeof value.env !== "object" ||
			value.env === null ||
			Array.isArray(value.env) ||
			Object.values(value.env).some((item) => typeof item !== "string"))
	)
		return false;
	if (value.files === undefined) return true;
	if (!Array.isArray(value.files) || value.files.length > MAX_FILES) return false;
	return value.files.every(
		(file) =>
			typeof file === "object" &&
			file !== null &&
			"path" in file &&
			typeof file.path === "string" &&
			file.path.length > 0 &&
			!isAbsolute(file.path) &&
			"content" in file &&
			typeof file.content === "string" &&
			Buffer.byteLength(file.content, "utf8") <= MAX_FILE_BYTES,
	);
}

function pathWithin(root: string, path: string, label: string): string {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, path);
	if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
		throw new Error(`${label} escapes its root: ${path}`);
	}
	return resolvedPath;
}

function macosProfile(scratchDirectory: string): string {
	const escapedScratch = scratchDirectory.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* (subpath "${escapedScratch}"))`,
		'(allow file-write* (literal "/dev/null"))',
	].join("\n");
}

function sandboxInvocation(
	command: string,
	workingDirectory: string,
	scratchDirectory: string,
): { command: string; args: string[] } {
	if (process.platform === "linux") {
		const configuredBwrap = process.env.PI_TEST_BWRAP;
		const bwrap = configuredBwrap ?? ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path));
		if (!bwrap || !isAbsolute(bwrap) || !existsSync(bwrap)) {
			throw new Error(
				"bubblewrap is unavailable; refusing an unisolated test run. Set PI_TEST_BWRAP to its absolute path.",
			);
		}
		return {
			command: bwrap,
			args: [
				"--die-with-parent",
				"--new-session",
				"--ro-bind",
				"/",
				"/",
				"--bind",
				scratchDirectory,
				scratchDirectory,
				"--dev-bind",
				"/dev",
				"/dev",
				"--proc",
				"/proc",
				"--share-net",
				"--chdir",
				workingDirectory,
				"/bin/sh",
				"-c",
				command,
			],
		};
	}
	if (process.platform === "darwin") {
		return {
			command: "/usr/bin/sandbox-exec",
			args: ["-p", macosProfile(scratchDirectory), "/bin/sh", "-c", command],
		};
	}
	throw new Error(`The test sandbox is not supported on ${process.platform}; refusing an unisolated test run.`);
}

async function executeSandboxed(
	invocation: { command: string; args: string[] },
	workingDirectory: string,
	environment: NodeJS.ProcessEnv,
	timeoutSeconds: number,
	signal: AbortSignal | undefined,
	onData: (data: Buffer) => void,
): Promise<number | null> {
	const child = spawn(invocation.command, invocation.args, {
		cwd: workingDirectory,
		detached: process.platform !== "win32",
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);

	let timedOut = false;
	const stop = () => {
		if (child.pid) killProcessTree(child.pid);
	};
	const timeout = setTimeout(() => {
		timedOut = true;
		stop();
	}, timeoutSeconds * 1000);
	if (signal?.aborted) stop();
	else signal?.addEventListener("abort", stop, { once: true });

	try {
		const exitCode = await waitForChildProcess(child);
		if (signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${timeoutSeconds}`);
		return exitCode;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", stop);
	}
}

export class IsolatedTestRunner {
	readonly projectRoot: string;

	constructor(projectRoot: string) {
		this.projectRoot = resolve(projectRoot);
	}

	async run(input: TestInput, signal?: AbortSignal): Promise<TestResult> {
		const unsafeEnvironmentKey = Object.keys(input.env ?? {}).find((key) => UNSAFE_LAUNCH_ENV.has(key));
		if (unsafeEnvironmentKey) {
			throw new Error(`The test environment cannot override sandbox launcher variable ${unsafeEnvironmentKey}.`);
		}
		const workingDirectory = pathWithin(this.projectRoot, input.projectPath ?? ".", "projectPath");
		const scratchDirectory = await mkdtemp(join(tmpdir(), "pi-test-"));
		const scratchTmp = join(scratchDirectory, "tmp");
		const scratchHome = join(scratchDirectory, "home");
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let outputTruncated = false;
		let exitCode: number | null = null;

		try {
			await Promise.all([mkdir(scratchTmp), mkdir(scratchHome)]);
			for (const file of input.files ?? []) {
				const target = pathWithin(scratchDirectory, file.path, "scratch file path");
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, file.content, "utf8");
			}

			const environment: NodeJS.ProcessEnv = {
				...process.env,
				...input.env,
				PWD: workingDirectory,
				CWD: workingDirectory,
				INIT_CWD: workingDirectory,
				PI_TEST_PROJECT_ROOT: this.projectRoot,
				PI_TEST_SCRATCH: scratchDirectory,
				TMPDIR: scratchTmp,
				TMP: scratchTmp,
				TEMP: scratchTmp,
				HOME: scratchHome,
				PYTHONPATH: input.env?.PYTHONPATH ? `${workingDirectory}:${input.env.PYTHONPATH}` : workingDirectory,
				XDG_CACHE_HOME: join(scratchDirectory, "cache"),
				npm_config_cache: join(scratchDirectory, "npm-cache"),
				CARGO_TARGET_DIR: join(scratchDirectory, "cargo-target"),
				GRADLE_USER_HOME: join(scratchDirectory, "gradle"),
				PYTHONPYCACHEPREFIX: join(scratchDirectory, "pycache"),
				COVERAGE_FILE: join(scratchDirectory, ".coverage"),
			};
			const invocation = sandboxInvocation(input.command, workingDirectory, scratchDirectory);
			exitCode = await executeSandboxed(
				invocation,
				workingDirectory,
				environment,
				input.timeout ?? 120,
				signal,
				(data) => {
					if (outputBytes >= MAX_OUTPUT_BYTES) {
						outputTruncated = true;
						return;
					}
					const remaining = MAX_OUTPUT_BYTES - outputBytes;
					const retained = data.length > remaining ? data.subarray(0, remaining) : data;
					chunks.push(retained);
					outputBytes += retained.length;
					if (retained.length !== data.length) outputTruncated = true;
				},
			);
		} finally {
			await rm(scratchDirectory, { force: true, recursive: true });
		}

		return {
			status: exitCode === 0 ? "passed" : "failed",
			exitCode,
			output: Buffer.concat(chunks).toString("utf8"),
			outputTruncated,
			projectRoot: this.projectRoot,
			workingDirectory,
			scratchDirectory,
			scratchRemoved: true,
			copiedBytes: 0,
		};
	}
}

export class TestSandboxMcpServer {
	async handle(request: TestSandboxMcpRequest, context: TestSandboxMcpContext): Promise<TestSandboxMcpResponse> {
		if (request.method === "initialize") {
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					protocolVersion: TEST_SANDBOX_MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "pi-test-sandbox", version: "1.0.0" },
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
							name: "test",
							title: "Run an isolated test",
							description:
								"Run tests against the active project without copying it. The project is readable but only a fresh /tmp scratch directory is writable.",
							inputSchema: TestParameters,
						},
					],
				},
			};
		}

		if (request.params.name !== "test") {
			return {
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32602, message: `Unknown tool: ${request.params.name}` },
			};
		}

		const args = request.params.arguments ?? {};
		if (!isTestInput(args)) {
			return {
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32602, message: "Invalid test arguments" },
			};
		}

		try {
			const result = await context.run(args);
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					content: [{ type: "text", text: result.output || `Test ${result.status}.` }],
					structuredContent: result,
					isError: result.status === "failed",
				},
			};
		} catch (error) {
			return {
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
			};
		}
	}
}

export class InProcessTestSandboxMcpClient {
	private readonly server: TestSandboxMcpServer;
	private initialized = false;
	private nextId = 1;

	constructor(server: TestSandboxMcpServer) {
		this.server = server;
	}

	async callTool(input: TestInput, context: TestSandboxMcpContext): Promise<TestResult> {
		if (!this.initialized) {
			const initialized = await this.server.handle(
				{
					jsonrpc: "2.0",
					id: this.nextId++,
					method: "initialize",
					params: {
						protocolVersion: TEST_SANDBOX_MCP_PROTOCOL_VERSION,
						capabilities: {},
						clientInfo: { name: "pi-coding-agent", version: "1.0.0" },
					},
				},
				context,
			);
			if ("error" in initialized) throw new Error(initialized.error.message);
			const listed = await this.server.handle({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list" }, context);
			if ("error" in listed) throw new Error(listed.error.message);
			const tools = listed.result.tools;
			if (
				!Array.isArray(tools) ||
				!tools.some((tool) => typeof tool === "object" && tool !== null && "name" in tool && tool.name === "test")
			) {
				throw new Error("MCP server did not advertise test");
			}
			this.initialized = true;
		}

		const response = await this.server.handle(
			{
				jsonrpc: "2.0",
				id: this.nextId++,
				method: "tools/call",
				params: { name: "test", arguments: input },
			},
			context,
		);
		if ("error" in response) throw new Error(response.error.message);
		return response.result.structuredContent as unknown as TestResult;
	}
}
