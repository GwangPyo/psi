import { describe, expect, it } from "vitest";
import { buildGoogleGeminiCliRequest } from "../src/api/google-gemini-cli.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "Use the tool.", timestamp: 0 }],
	tools: [
		{
			name: "read",
			description: "Read a file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	],
};

function model(id: string, name: string): Model<"google-gemini-cli"> {
	return {
		id,
		name,
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};
}

describe("Google Cloud Code Assist tool schemas", () => {
	it("uses parameters for Claude models", () => {
		const request = buildGoogleGeminiCliRequest(model("claude-sonnet-4-5", "Claude Sonnet 4.5"), context, "project");

		expect(request.request.tools).toEqual([
			{
				functionDeclarations: [
					{
						name: "read",
						description: "Read a file.",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				],
			},
		]);
	});

	it("uses parametersJsonSchema for Gemini models", () => {
		const request = buildGoogleGeminiCliRequest(model("gemini-3-pro", "Gemini 3 Pro"), context, "project");

		expect(request.request.tools?.[0]?.functionDeclarations?.[0]).toHaveProperty("parametersJsonSchema");
	});
});
