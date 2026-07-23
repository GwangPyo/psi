import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [typescriptModule, projectRoot] = process.argv.slice(2);
if (!typescriptModule || !projectRoot) {
	throw new Error("usage: node typescript_extractor.mjs <typescript.js> <project-root>");
}

const require = createRequire(import.meta.url);
const ts = require(path.resolve(typescriptModule));
const excluded = new Set([".git", ".hg", ".svn", ".venv", "node_modules", "dist", "build", "__pycache__"]);
const extensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

function files(directory) {
	const result = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!excluded.has(entry.name)) result.push(...files(path.join(directory, entry.name)));
			continue;
		}
		const fullPath = path.join(directory, entry.name);
		if (extensions.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) result.push(fullPath);
	}
	return result;
}

function annotation(node, source) {
	if (!node) return "Unknown";
	const value = node.getText(source);
	return new Map([
		["number", "Float"],
		["bigint", "Int"],
		["boolean", "Bool"],
		["string", "String"],
		["void", "Unit"],
	]).get(value) ?? value;
}

function expression(node, parameters, numeric, source) {
	if (ts.isParenthesizedExpression(node)) return expression(node.expression, parameters, numeric, source);
	if (ts.isIdentifier(node) && parameters.has(node.text)) return `arg:${parameters.get(node.text)}`;
	if (ts.isNumericLiteral(node)) return `const:${node.text}`;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return `const:${JSON.stringify(node.text)}`;
	if (node.kind === ts.SyntaxKind.TrueKeyword) return "const:true";
	if (node.kind === ts.SyntaxKind.FalseKeyword) return "const:false";
	if (node.kind === ts.SyntaxKind.NullKeyword) return "const:null";
	if (ts.isPrefixUnaryExpression(node)) {
		const operand = expression(node.operand, parameters, numeric, source);
		const operator = new Map([
			[ts.SyntaxKind.MinusToken, "neg"],
			[ts.SyntaxKind.PlusToken, "pos"],
			[ts.SyntaxKind.ExclamationToken, "not"],
		]).get(node.operator);
		return operand && operator ? `${operator}(${operand})` : null;
	}
	if (ts.isBinaryExpression(node)) {
		const left = expression(node.left, parameters, numeric, source);
		const right = expression(node.right, parameters, numeric, source);
		const operator = new Map([
			[ts.SyntaxKind.PlusToken, "add"],
			[ts.SyntaxKind.MinusToken, "sub"],
			[ts.SyntaxKind.AsteriskToken, "mul"],
			[ts.SyntaxKind.SlashToken, "div"],
			[ts.SyntaxKind.PercentToken, "mod"],
			[ts.SyntaxKind.EqualsEqualsEqualsToken, "eq"],
			[ts.SyntaxKind.ExclamationEqualsEqualsToken, "ne"],
			[ts.SyntaxKind.LessThanToken, "lt"],
			[ts.SyntaxKind.LessThanEqualsToken, "le"],
			[ts.SyntaxKind.GreaterThanToken, "gt"],
			[ts.SyntaxKind.GreaterThanEqualsToken, "ge"],
			[ts.SyntaxKind.AmpersandAmpersandToken, "and"],
			[ts.SyntaxKind.BarBarToken, "or"],
		]).get(node.operatorToken.kind);
		if (!left || !right || !operator) return null;
		const operands = numeric && (operator === "add" || operator === "mul") ? [left, right].sort() : [left, right];
		return `${operator}(${operands[0]},${operands[1]})`;
	}
	if (ts.isConditionalExpression(node)) {
		const condition = expression(node.condition, parameters, numeric, source);
		const positive = expression(node.whenTrue, parameters, numeric, source);
		const negative = expression(node.whenFalse, parameters, numeric, source);
		return condition && positive && negative ? `if(${condition},${positive},${negative})` : null;
	}
	return null;
}

function contract(node, source) {
	if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return null;
	let returnExpression = null;
	if (node.body && ts.isBlock(node.body)) {
		if (node.body.statements.length !== 1 || !ts.isReturnStatement(node.body.statements[0])) return null;
		returnExpression = node.body.statements[0].expression;
	} else if (node.body) {
		returnExpression = node.body;
	}
	if (!returnExpression) return null;
	const parameterMap = new Map();
	const inputKinds = [];
	for (const [index, parameter] of node.parameters.entries()) {
		if (!ts.isIdentifier(parameter.name)) return null;
		parameterMap.set(parameter.name.text, index);
		inputKinds.push(annotation(parameter.type, source));
	}
	const outputKind = annotation(node.type, source);
	const numeric = inputKinds.length > 0 && [...inputKinds, outputKind].every((item) => item === "Float" || item === "Int");
	const behavior = expression(returnExpression, parameterMap, numeric, source);
	if (!behavior) return null;
	return {
		input_kinds: inputKinds,
		output_kind: outputKind,
		behavior,
		effect: "pure",
		failure_modes: [],
	};
}

function visit(source, relativePath) {
	const result = [];
	function walk(node, owner = "") {
		let name = null;
		if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
		if (ts.isMethodDeclaration(node) && node.name) name = node.name.getText(source);
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
			(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
			const target = node.initializer;
			const start = source.getLineAndCharacterOfPosition(node.getStart(source));
			const end = source.getLineAndCharacterOfPosition(node.end);
			const text = node.getText(source);
			result.push({
				qualified_name: `${owner}${node.name.text}`,
				start_line: start.line + 1,
				end_line: end.line + 1,
				source_hash: crypto.createHash("sha256").update(text).digest("hex"),
				contract: contract(target, source),
			});
		}
		if (name && node.body) {
			const start = source.getLineAndCharacterOfPosition(node.getStart(source));
			const end = source.getLineAndCharacterOfPosition(node.end);
			result.push({
				qualified_name: `${owner}${name}`,
				start_line: start.line + 1,
				end_line: end.line + 1,
				source_hash: crypto.createHash("sha256").update(node.getText(source)).digest("hex"),
				contract: contract(node, source),
			});
		}
		let nextOwner = owner;
		if ((ts.isClassDeclaration(node) || ts.isModuleDeclaration(node)) && node.name) {
			nextOwner = `${owner}${node.name.getText(source)}.`;
		} else if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
			nextOwner = `${owner}${node.name.getText(source)}.`;
		} else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
			(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
			nextOwner = `${owner}${node.name.text}.`;
		}
		ts.forEachChild(node, (child) => walk(child, nextOwner));
	}
	walk(source);
	return result.map((item) => ({ ...item, path: relativePath }));
}

const output = [];
for (const file of files(path.resolve(projectRoot)).sort()) {
	const text = fs.readFileSync(file, "utf8");
	const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
	output.push(...visit(source, path.relative(path.resolve(projectRoot), file)));
}
process.stdout.write(JSON.stringify({ typescript_version: ts.version, objects: output }));
