import { type ExtensionAPI, isBashToolResult, isToolCallEventType } from "../../core/extensions/types.ts";

export const RM_SAFETY_MESSAGE = "message from hook: rm -rf is detected. replaced by rm -r by safety reason";

interface ShellToken {
	kind: "word" | "operator";
	start: number;
	end: number;
	value: string;
}

interface Replacement {
	start: number;
	end: number;
	value: string;
}

const COMMAND_SEPARATORS = new Set(["\n", ";", ";;", "&", "&&", "|", "||", "|&", "(", ")", "{", "}"]);
const REDIRECTIONS = new Set(["<", ">", "<<", ">>", "<<<", "<>", "<&", ">&", ">|"]);
const COMMAND_PREFIXES = new Set(["!", "if", "then", "elif", "else", "do", "while", "until"]);
const SIMPLE_WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time"]);

function isOperatorStart(character: string): boolean {
	return "\n;&|(){}<>".includes(character);
}

function readOperator(command: string, start: number): ShellToken {
	const candidates = ["<<<", "&&", "||", "|&", ";;", "<<", ">>", "<>", "<&", ">&", ">|"];
	const value = candidates.find((candidate) => command.startsWith(candidate, start)) ?? command[start];
	return { kind: "operator", start, end: start + value.length, value };
}

function tokenizeShell(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let index = 0;

	while (index < command.length) {
		const character = command[index];
		if (character === " " || character === "\t" || character === "\r") {
			index++;
			continue;
		}
		if (character === "#") {
			while (index < command.length && command[index] !== "\n") index++;
			continue;
		}
		if (isOperatorStart(character)) {
			const operator = readOperator(command, index);
			tokens.push(operator);
			index = operator.end;
			continue;
		}

		const start = index;
		let value = "";
		while (index < command.length) {
			const current = command[index];
			if (current === " " || current === "\t" || current === "\r" || isOperatorStart(current)) break;
			if (current === "\\") {
				if (index + 1 < command.length) {
					if (command[index + 1] !== "\n") value += command[index + 1];
					index += 2;
				} else {
					value += current;
					index++;
				}
				continue;
			}
			if (current === "'") {
				index++;
				while (index < command.length && command[index] !== "'") {
					value += command[index];
					index++;
				}
				if (command[index] === "'") index++;
				continue;
			}
			if (current === '"') {
				index++;
				while (index < command.length && command[index] !== '"') {
					if (command[index] === "\\" && index + 1 < command.length) {
						value += command[index + 1];
						index += 2;
					} else {
						value += command[index];
						index++;
					}
				}
				if (command[index] === '"') index++;
				continue;
			}
			value += current;
			index++;
		}
		tokens.push({ kind: "word", start, end: index, value });
	}

	return tokens;
}

function isAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function commandName(word: string): string {
	const slash = word.lastIndexOf("/");
	return slash === -1 ? word : word.slice(slash + 1);
}

function skipRedirection(tokens: ShellToken[], index: number, end: number): number {
	if (index >= end || tokens[index].kind !== "operator" || !REDIRECTIONS.has(tokens[index].value)) return index;
	const next = index + 1;
	return next < end && tokens[next].kind === "word" ? next + 1 : next;
}

function commandWords(tokens: ShellToken[], start: number, end: number): ShellToken[] {
	const words: ShellToken[] = [];
	let index = start;
	while (index < end) {
		const token = tokens[index];
		if (
			token.kind === "word" &&
			/^\d+$/.test(token.value) &&
			index + 1 < end &&
			tokens[index + 1].kind === "operator" &&
			REDIRECTIONS.has(tokens[index + 1].value)
		) {
			index = skipRedirection(tokens, index + 1, end);
			continue;
		}
		const afterRedirection = skipRedirection(tokens, index, end);
		if (afterRedirection !== index) {
			index = afterRedirection;
			continue;
		}
		if (token.kind === "word") words.push(token);
		index++;
	}
	return words;
}

function skipWrapperOptions(words: ShellToken[], start: number): number {
	let index = start;
	while (index < words.length && words[index].value.startsWith("-") && words[index].value !== "--") index++;
	return words[index]?.value === "--" ? index + 1 : index;
}

function skipEnvPrefix(words: ShellToken[], start: number): number {
	let index = start;
	while (index < words.length) {
		const value = words[index].value;
		if (isAssignment(value)) {
			index++;
			continue;
		}
		if (value === "--") return index + 1;
		if (value === "-u" || value === "--unset" || value === "-C" || value === "--chdir" || value === "-S") {
			index += 2;
			continue;
		}
		if (value.startsWith("--unset=") || value.startsWith("--chdir=") || value.startsWith("--split-string=")) {
			index++;
			continue;
		}
		if (value.startsWith("-")) {
			index++;
			continue;
		}
		break;
	}
	return index;
}

function skipSudoPrefix(words: ShellToken[], start: number): number {
	const optionsWithValues = new Set([
		"-C",
		"-D",
		"-g",
		"-h",
		"-p",
		"-R",
		"-r",
		"-T",
		"-t",
		"-u",
		"--chdir",
		"--close-from",
		"--group",
		"--host",
		"--prompt",
		"--role",
		"--type",
		"--user",
	]);
	let index = start;
	while (index < words.length) {
		const value = words[index].value;
		if (value === "--") return index + 1;
		if (optionsWithValues.has(value)) {
			index += 2;
			continue;
		}
		if (value.startsWith("-")) {
			index++;
			continue;
		}
		break;
	}
	return index;
}

function findCommandIndex(words: ShellToken[]): number {
	let index = 0;
	while (index < words.length && (isAssignment(words[index].value) || COMMAND_PREFIXES.has(words[index].value)))
		index++;

	while (index < words.length) {
		const name = commandName(words[index].value);
		if (name === "env") {
			index = skipEnvPrefix(words, index + 1);
			continue;
		}
		if (name === "sudo") {
			index = skipSudoPrefix(words, index + 1);
			continue;
		}
		if (SIMPLE_WRAPPERS.has(name)) {
			index = skipWrapperOptions(words, index + 1);
			continue;
		}
		break;
	}
	return index;
}

function rmOptionReplacement(token: ShellToken): { recursive: boolean; force: boolean; replacement?: Replacement } {
	if (token.value === "--recursive") return { recursive: true, force: false };
	if (token.value === "--force") {
		return { recursive: false, force: true, replacement: { start: token.start, end: token.end, value: "" } };
	}
	if (!/^-[A-Za-z]+$/.test(token.value)) return { recursive: false, force: false };

	const flags = token.value.slice(1);
	const recursive = flags.includes("r") || flags.includes("R");
	const force = flags.includes("f");
	if (!force) return { recursive, force: false };

	const remaining = [...flags].filter((flag) => flag !== "f").join("");
	return {
		recursive,
		force: true,
		replacement: { start: token.start, end: token.end, value: remaining ? `-${remaining}` : "" },
	};
}

function collectRmReplacements(words: ShellToken[]): Replacement[] {
	const commandIndex = findCommandIndex(words);
	if (commandIndex >= words.length || commandName(words[commandIndex].value) !== "rm") return [];

	let recursive = false;
	let force = false;
	let optionsEnded = false;
	const forceReplacements: Replacement[] = [];

	for (const token of words.slice(commandIndex + 1)) {
		if (token.value === "--") {
			optionsEnded = true;
			continue;
		}
		if (optionsEnded) continue;
		const option = rmOptionReplacement(token);
		recursive ||= option.recursive;
		force ||= option.force;
		if (option.replacement) forceReplacements.push(option.replacement);
	}

	return recursive && force ? forceReplacements : [];
}

export function replaceRecursiveForceRm(command: string): { command: string; replaced: boolean } {
	const tokens = tokenizeShell(command);
	const replacements: Replacement[] = [];
	let segmentStart = 0;

	for (let index = 0; index <= tokens.length; index++) {
		if (index < tokens.length && !COMMAND_SEPARATORS.has(tokens[index].value)) continue;
		replacements.push(...collectRmReplacements(commandWords(tokens, segmentStart, index)));
		segmentStart = index + 1;
	}

	if (replacements.length === 0) return { command, replaced: false };
	let rewritten = command;
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		rewritten = rewritten.slice(0, replacement.start) + replacement.value + rewritten.slice(replacement.end);
	}
	return { command: rewritten, replaced: true };
}

export function createRmSafetyExtension() {
	return function rmSafetyExtension(pi: ExtensionAPI): void {
		const rewrittenCalls = new Set<string>();

		pi.on("tool_call", (event) => {
			if (!isToolCallEventType("bash", event)) return;
			const result = replaceRecursiveForceRm(event.input.command);
			if (!result.replaced) return;
			event.input.command = result.command;
			rewrittenCalls.add(event.toolCallId);
		});

		pi.on("tool_result", (event) => {
			if (!isBashToolResult(event) || !rewrittenCalls.delete(event.toolCallId)) return;
			return {
				content: [{ type: "text", text: RM_SAFETY_MESSAGE }, ...event.content],
			};
		});
	};
}

export default createRmSafetyExtension();
