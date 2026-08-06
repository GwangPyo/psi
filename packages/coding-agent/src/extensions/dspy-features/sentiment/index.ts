import { readFileSync } from "node:fs";
import type { Api, AssistantMessage, Context, Tool } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { formatTemplate } from "../../../utils/template.ts";

const NEGATIVE_REACTION_TOOL_NAME = "report_negative_reaction";

const NegativeReactionSchema = Type.Object(
	{
		negative_reaction: Type.Boolean({
			description:
				"True only when the user's reply expresses strong negative emotion about the assistant's immediately preceding result. False otherwise.",
		}),
	},
	{ additionalProperties: false },
);

const negativeReactionCheck = Compile(NegativeReactionSchema);

const NEGATIVE_REACTION_TOOL: Tool<typeof NegativeReactionSchema> = {
	name: NEGATIVE_REACTION_TOOL_NAME,
	description:
		"Report whether the user's reply expresses strong negative emotion about the assistant's immediately preceding result.",
	parameters: NegativeReactionSchema,
};

const SENTIMENT_SYSTEM_PROMPT = formatTemplate(
	readFileSync(new URL("../../../core/emotion-analysis-prompt.md", import.meta.url), "utf8").trim(),
	{ TOOL_NAME: NEGATIVE_REACTION_TOOL_NAME },
);

/**
 * Value that forces the single supplied tool. The APIs disagree on the literal:
 * Anthropic/Bedrock/Google/Mistral use "any", the OpenAI-shaped APIs use "required".
 * Undefined for APIs without tool choice support; the classification then depends on
 * the model calling the only tool it was given, and is discarded when it does not.
 */
export type SentimentToolChoice = "any" | "required" | undefined;

export type SentimentCompletion = (context: Context, toolChoice: SentimentToolChoice) => Promise<AssistantMessage>;

export function sentimentToolChoice(api: Api): SentimentToolChoice {
	switch (api) {
		case "anthropic-messages":
		case "bedrock-converse-stream":
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
		case "mistral-conversations":
			return "any";
		case "openai-completions":
		case "openai-responses":
		case "openai-codex-responses":
		case "pi-messages":
			return "required";
		default:
			return undefined;
	}
}

export function buildSentimentContext(assistantResult: string, userReply: string): Context {
	return {
		systemPrompt: SENTIMENT_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `<new_interaction>\n<assistant_result>\n${assistantResult}\n</assistant_result>\n<user_reply>\n${userReply}\n</user_reply>\n</new_interaction>`,
					},
				],
				timestamp: Date.now(),
			},
		],
		tools: [NEGATIVE_REACTION_TOOL],
	};
}

/**
 * Read the classification out of a response. Returns undefined when the model produced
 * anything other than a schema-conforming tool call, so a non-compliant answer is never
 * mistaken for a classification.
 */
export function readNegativeSentiment(message: AssistantMessage): Static<typeof NegativeReactionSchema> | undefined {
	for (const block of message.content) {
		if (block.type !== "toolCall" || block.name !== NEGATIVE_REACTION_TOOL_NAME) continue;
		if (!negativeReactionCheck.Check(block.arguments)) return undefined;
		return block.arguments;
	}
	return undefined;
}

export async function classifyNegativeSentiment(
	complete: SentimentCompletion,
	api: Api,
	assistantResult: string,
	userReply: string,
): Promise<boolean> {
	const message = await complete(buildSentimentContext(assistantResult, userReply), sentimentToolChoice(api));
	return readNegativeSentiment(message)?.negative_reaction ?? false;
}
