import { describe, expect, it } from "vitest";
import { parseStreamingJson } from "../src/utils/json-parse.ts";

describe("parseStreamingJson", () => {
	it("repairs control characters before partially parsing incomplete JSON", () => {
		const controlCharacter = String.fromCharCode(0x0b);
		const partialJson = `{"text":"hello${controlCharacter}world`;

		expect(parseStreamingJson<{ text: string }>(partialJson)).toEqual({ text: `hello${controlCharacter}world` });
	});
});
