import {
	type ChatMessage,
	type ILanguageModel,
	type LLMCallOptions,
	type ModelCapabilities,
	Predict,
	type UsageStats,
} from "@ts-dspy/core";

const SENTIMENT_RULE =
	"Return true only when the user expresses strong negative emotion about the assistant's immediately preceding result. Otherwise return false.";

interface SentimentCompletion {
	complete(prompt: string): Promise<string>;
}

class PiAccountDspyLM implements ILanguageModel {
	private readonly completion: SentimentCompletion;

	constructor(completion: SentimentCompletion) {
		this.completion = completion;
	}

	generate(prompt: string, _options?: LLMCallOptions): Promise<string> {
		return this.completion.complete(prompt);
	}

	async generateStructured<T>(_prompt: string, _schema: unknown, _options?: LLMCallOptions): Promise<T> {
		throw new Error("The sentiment DSPy program only generates boolean predictions");
	}

	async chat(_messages: ChatMessage[], _options?: LLMCallOptions): Promise<string> {
		throw new Error("The sentiment DSPy program only generates predictions");
	}

	getUsage(): UsageStats {
		return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	}

	resetUsage(): void {}

	getCapabilities(): ModelCapabilities {
		return {
			supportsStreaming: false,
			supportsStructuredOutput: false,
			supportsFunctionCalling: false,
			supportsVision: false,
			maxContextLength: 0,
			supportedFormats: ["text"],
		};
	}

	getModelName(): string {
		return "pi-account";
	}
}

export async function classifyNegativeSentiment(
	completion: SentimentCompletion,
	assistantResult: string,
	userReply: string,
): Promise<boolean> {
	const predictor = new Predict(
		"classification_rule, assistant_result, user_reply -> negative_reaction: boolean",
		new PiAccountDspyLM(completion),
	);
	const prediction = await predictor.forward({
		classification_rule: SENTIMENT_RULE,
		assistant_result: assistantResult,
		user_reply: userReply,
	});
	const negativeReaction: unknown = prediction.negative_reaction;
	return (
		negativeReaction === true ||
		(typeof negativeReaction === "string" && negativeReaction.trim().toLowerCase() === "true")
	);
}
