import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const template = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf8");

test("exported session usage shows tokens without estimated cost", () => {
	expect(template).toContain('info-label">Tokens:');
	expect(template).not.toContain('info-label">Cost:');
});
