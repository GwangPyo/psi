import { existsSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import {
	InProcessTestSandboxMcpClient,
	IsolatedTestRunner,
	type TestInput,
	TestParameters,
	type TestResult,
	TestSandboxMcpServer,
} from "../../core/mcp/test-sandbox-server.ts";

const TEST_POLICY = `<test_sandbox_policy>
All test runner commands and ad-hoc verification scripts must use the test tool.
Do not create scratch tests, fixtures, reproducers, or generated test output in the project with write, edit, or bash.
The test tool reads the project in place without copying it, creates supplied files under a fresh /tmp scratch directory, and makes only that scratch directory writable.
</test_sandbox_policy>`;

const COMMAND_PREFIX =
	"(?:^|[;&|()\\n])\\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|\"[^\"]*\"|\\S+)\\s+)|(?:env\\s+)|(?:sudo\\s+)|(?:timeout\\s+\\S+\\s+))*";

const TEST_RUNNER =
	"(?:npm\\s+(?:run\\s+)?test(?=\\s|:|$)|pnpm\\s+(?:run\\s+)?test(?=\\s|:|$)|yarn\\s+(?:run\\s+)?test(?=\\s|:|$)|bun\\s+test(?=\\s|$)|(?:npx\\s+)?(?:vitest|jest|mocha|ava|tap)\\b|node\\s+--test\\b|(?:python\\d*\\s+-m\\s+)?(?:pytest|unittest)\\b|uv\\s+run\\s+(?:python\\d*\\s+-m\\s+)?pytest\\b|cargo\\s+(?:test|nextest\\s+run)\\b|go\\s+test\\b|dotnet\\s+test\\b|(?:mvn|mvnw|gradle|gradlew)\\s+.*\\btest\\b|(?:make|just)\\s+(?:test|check)\\b|(?:\\.\\/)?(?:test|tests)(?:\\.sh|\\.bash|\\b))";

const TEST_COMMAND_PATTERN = new RegExp(`${COMMAND_PREFIX}${TEST_RUNNER}`, "iu");
const TEST_SUITE_DIRECTORIES = new Set(["__tests__", "spec", "specs", "test", "tests"]);
const AD_HOC_TEST_FILE_PATTERN =
	/(?:^|[._-])(?:debug|manual[-_]?test|probe|quick[-_]?test|repro|reproducer|scratch|temp|test[-_]?script|tmp)(?:[._-]|$)/iu;
const BARE_TEST_FILE_PATTERN = /^tests?\.(?:bash|c|cc|cpp|go|java|js|jsx|mjs|py|rb|rs|sh|ts|tsx)$/iu;

export function isTestCommand(command: string): boolean {
	return TEST_COMMAND_PATTERN.test(command.replaceAll("\\\n", " "));
}

export function isAdHocProjectTestPath(path: string, cwd: string): boolean {
	const projectRoot = resolve(cwd);
	const resolvedPath = resolve(projectRoot, path);
	const projectRelative = relative(projectRoot, resolvedPath);
	if (projectRelative === ".." || projectRelative.startsWith(`..${sep}`)) return false;
	const segments = projectRelative.split(sep);
	if (segments.slice(0, -1).some((segment) => TEST_SUITE_DIRECTORIES.has(segment.toLowerCase()))) return false;
	const fileName = basename(resolvedPath);
	return AD_HOC_TEST_FILE_PATTERN.test(fileName) || BARE_TEST_FILE_PATTERN.test(fileName);
}

export interface TestSandboxClient {
	callTool(input: TestInput, context: { run(input: TestInput): Promise<TestResult> }): Promise<TestResult>;
}

export function createTestSandboxExtension(options: { client?: TestSandboxClient } = {}) {
	return function testSandboxExtension(pi: ExtensionAPI): void {
		const client = options.client ?? new InProcessTestSandboxMcpClient(new TestSandboxMcpServer());

		pi.registerTool({
			name: "test",
			label: "Test (isolated)",
			description:
				"Mandatory runner for tests and ad-hoc verification. Reads the active project in place without copying it; creates supplied files in /tmp and uses an OS sandbox so only that scratch directory is writable.",
			promptSnippet: "Run tests with the project read-only and /tmp scratch writable",
			promptGuidelines: [
				"Pass every ad-hoc test, fixture, reproducer, or helper through files instead of writing it into the project.",
				"Use PI_TEST_SCRATCH to reference supplied files and generated output, and PI_TEST_PROJECT_ROOT to reference project sources.",
				"The worktree is not copied. A write outside PI_TEST_SCRATCH is a test isolation failure and must not be bypassed.",
			],
			parameters: TestParameters,
			executionMode: "sequential",
			async execute(_toolCallId, input: TestInput, signal, _onUpdate, ctx) {
				const runner = new IsolatedTestRunner(ctx.cwd);
				const result = await client.callTool(input, { run: (request) => runner.run(request, signal) });
				return {
					content: [
						{
							type: "text",
							text:
								result.output ||
								`Test ${result.status} with exit code ${result.exitCode ?? "unknown"}. Scratch was removed.`,
						},
					],
					details: result,
					isError: result.status === "failed",
				};
			},
		});

		pi.on("before_agent_start", (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${TEST_POLICY}`,
		}));

		pi.on("tool_call", (event, ctx) => {
			if (
				event.toolName === "write" &&
				typeof event.input.path === "string" &&
				!existsSync(resolve(ctx.cwd, event.input.path)) &&
				isAdHocProjectTestPath(event.input.path, ctx.cwd)
			) {
				return {
					block: true,
					reason:
						"Do not create ad-hoc test, scratch, repro, debug, or probe files in the project. Supply the file through test.files so it is created in the disposable /tmp scratch directory.",
				};
			}
			if (
				event.toolName !== "bash" ||
				typeof event.input.command !== "string" ||
				!isTestCommand(event.input.command)
			)
				return;
			return {
				block: true,
				reason:
					"Direct test execution is disabled. Use the test tool so ad-hoc files and outputs are confined to its /tmp scratch directory.",
			};
		});
	};
}

export default createTestSandboxExtension();
