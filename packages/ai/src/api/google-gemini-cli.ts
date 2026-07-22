import type { Content, ThinkingConfig } from "@google/genai";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReasonString,
	mapToolChoice,
	retainThoughtSignature,
} from "./google-shared.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "./simple-options.ts";

export type GoogleGeminiCliThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface GoogleGeminiCliOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleGeminiCliThinkingLevel;
	};
}

interface CloudCodeAssistRequest {
	model: string;
	project: string;
	requestType: "agent";
	userAgent: "antigravity";
	requestId: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { parts: Array<{ text: string }> };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: ReturnType<typeof convertTools>;
		toolConfig?: {
			functionCallingConfig: { mode: ReturnType<typeof mapToolChoice> };
		};
	};
}

interface CloudCodeAssistChunk {
	response?: {
		candidates?: Array<{
			content?: {
				parts?: Array<{
					text?: string;
					thought?: boolean;
					thoughtSignature?: string;
					functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
				}>;
			};
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		responseId?: string;
	};
	traceId?: string;
}

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const REFRESH_ERROR = "Google Antigravity requires Google OAuth. Run /login and select Google Antigravity.";
const ANTIGRAVITY_HEADERS = {
	"User-Agent": `antigravity/${typeof process !== "undefined" && process.env.PI_AI_ANTIGRAVITY_VERSION ? process.env.PI_AI_ANTIGRAVITY_VERSION : "1.1.5"} linux/x64`,
};

let toolCallCounter = 0;

function parseCredential(value: string | undefined): { token: string; projectId: string } {
	if (!value) throw new Error(REFRESH_ERROR);
	try {
		const parsed = JSON.parse(value) as { token?: unknown; projectId?: unknown };
		if (
			typeof parsed.token === "string" &&
			parsed.token &&
			typeof parsed.projectId === "string" &&
			parsed.projectId
		) {
			return { token: parsed.token, projectId: parsed.projectId };
		}
	} catch {
		// Fall through to the actionable credential error below.
	}
	throw new Error("Invalid Google Cloud Code Assist credentials. Run /login and sign in again.");
}

function isGemini3Pro(modelId: string, modelName = ""): boolean {
	return /gemini\s*-?\s*3(?:\.\d+)?\s*-?\s*pro/.test(`${modelId} ${modelName}`.toLowerCase());
}

function isGemini3Family(modelId: string, modelName = ""): boolean {
	return /(?:gemini|gemma)\s*-?\s*[34]/.test(`${modelId} ${modelName}`.toLowerCase());
}

function disabledThinkingConfig(modelId: string, modelName = ""): ThinkingConfig {
	if (isGemini3Pro(modelId, modelName)) return { thinkingLevel: "LOW" as never };
	if (isGemini3Family(modelId, modelName)) return { thinkingLevel: "MINIMAL" as never };
	return { thinkingBudget: 0 };
}

function thinkingLevel(
	modelId: string,
	modelName: string,
	effort: "minimal" | "low" | "medium" | "high",
): GoogleGeminiCliThinkingLevel {
	if (isGemini3Pro(modelId, modelName)) return effort === "minimal" || effort === "low" ? "LOW" : "HIGH";
	return { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }[effort] as GoogleGeminiCliThinkingLevel;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Request was aborted"));
			},
			{ once: true },
		);
	});
}

function retryDelay(response: Response, body: string): number | undefined {
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date) && date > Date.now()) return date - Date.now();
	}
	const detail = body.match(/"retryDelay"\s*:\s*"([0-9.]+)s"/i)?.[1];
	if (detail) return Math.ceil(Number(detail) * 1000);
	const message = body.match(/(?:retry in|reset after)\s+([0-9.]+)s/i)?.[1];
	return message ? Math.ceil(Number(message) * 1000) : undefined;
}

function errorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
		if (parsed.error?.message)
			return parsed.error.status ? `${parsed.error.status}: ${parsed.error.message}` : parsed.error.message;
	} catch {
		// Preserve non-JSON provider errors.
	}
	return body;
}

async function requestStream(
	url: string,
	headers: Record<string, string>,
	body: string,
	model: Model<"google-gemini-cli">,
	options: GoogleGeminiCliOptions | undefined,
): Promise<Response> {
	const maxRetries = options?.maxRetries ?? MAX_RETRIES;
	for (let attempt = 0; ; attempt++) {
		if (options?.signal?.aborted) throw new Error("Request was aborted");
		let response: Response;
		try {
			response = await fetch(url, { method: "POST", headers, body, signal: options?.signal });
		} catch (error) {
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (attempt >= maxRetries) throw error;
			await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
			continue;
		}
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		if (response.ok) return response;

		const bodyText = await response.text();
		const retryable = response.status === 429 || response.status === 499 || response.status >= 500;
		if (!retryable || attempt >= maxRetries) {
			const iamHint =
				response.status === 403
					? " Check GOOGLE_CLOUD_PROJECT and the Cloud AI Companion User / Service Usage Consumer roles."
					: "";
			throw new Error(`Cloud Code Assist API error (${response.status}): ${errorMessage(bodyText)}${iamHint}`);
		}

		const serverDelay = retryDelay(response, bodyText);
		const delay = serverDelay ?? BASE_DELAY_MS * 2 ** attempt;
		const maxDelay = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
		if (maxDelay > 0 && delay > maxDelay) {
			throw new Error(
				`Server requested ${Math.ceil(delay / 1000)}s retry delay (max: ${Math.ceil(maxDelay / 1000)}s). ${errorMessage(bodyText)}`,
			);
		}
		await sleep(delay, options?.signal);
	}
}

export function buildGoogleGeminiCliRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
): CloudCodeAssistRequest {
	const generationConfig: NonNullable<CloudCodeAssistRequest["request"]["generationConfig"]> = {};
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level as never;
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		generationConfig.thinkingConfig = disabledThinkingConfig(model.id, model.name);
	}

	const request: CloudCodeAssistRequest["request"] = { contents: convertMessages(model, context) };
	if (options.sessionId) request.sessionId = options.sessionId;
	if (context.systemPrompt) {
		request.systemInstruction = { parts: [{ text: sanitizeSurrogates(context.systemPrompt) }] };
	}
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
	if (context.tools?.length) {
		request.tools = convertTools(context.tools);
		if (options.toolChoice) {
			request.toolConfig = { functionCallingConfig: { mode: mapToolChoice(options.toolChoice) } };
		}
	}

	return {
		model: model.id,
		project: projectId,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
		request,
	};
}

function processChunk(
	chunk: CloudCodeAssistChunk,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: { currentBlock: TextContent | ThinkingContent | null; started: boolean; hasContent: boolean },
	model: Model<"google-gemini-cli">,
): void {
	const response = chunk.response;
	if (!response) return;
	output.responseId ||= response.responseId || chunk.traceId;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	const ensureStarted = () => {
		if (!state.started) {
			stream.push({ type: "start", partial: output });
			state.started = true;
		}
	};
	const endCurrentBlock = () => {
		if (state.currentBlock?.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: blockIndex(),
				content: state.currentBlock.text,
				partial: output,
			});
		} else if (state.currentBlock?.type === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex: blockIndex(),
				content: state.currentBlock.thinking,
				partial: output,
			});
		}
		state.currentBlock = null;
	};

	const candidate = response.candidates?.[0];
	for (const part of candidate?.content?.parts ?? []) {
		if (part.text !== undefined) {
			state.hasContent = true;
			const thinking = isThinkingPart(part);
			if (
				!state.currentBlock ||
				(thinking && state.currentBlock.type !== "thinking") ||
				(!thinking && state.currentBlock.type !== "text")
			) {
				endCurrentBlock();
				state.currentBlock = thinking
					? { type: "thinking", thinking: "", thinkingSignature: undefined }
					: { type: "text", text: "" };
				output.content.push(state.currentBlock);
				ensureStarted();
				stream.push(
					thinking
						? { type: "thinking_start", contentIndex: blockIndex(), partial: output }
						: { type: "text_start", contentIndex: blockIndex(), partial: output },
				);
			}
			if (state.currentBlock.type === "thinking") {
				state.currentBlock.thinking += part.text;
				state.currentBlock.thinkingSignature = retainThoughtSignature(
					state.currentBlock.thinkingSignature,
					part.thoughtSignature,
				);
				stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta: part.text, partial: output });
			} else {
				state.currentBlock.text += part.text;
				state.currentBlock.textSignature = retainThoughtSignature(
					state.currentBlock.textSignature,
					part.thoughtSignature,
				);
				stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: part.text, partial: output });
			}
		}

		if (part.functionCall) {
			state.hasContent = true;
			endCurrentBlock();
			const providedId = part.functionCall.id;
			const id =
				providedId && !output.content.some((block) => block.type === "toolCall" && block.id === providedId)
					? providedId
					: `${part.functionCall.name || "tool"}_${Date.now()}_${++toolCallCounter}`;
			const toolCall: ToolCall = {
				type: "toolCall",
				id,
				name: part.functionCall.name || "",
				arguments: part.functionCall.args ?? {},
				...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
			};
			output.content.push(toolCall);
			ensureStarted();
			stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			stream.push({
				type: "toolcall_delta",
				contentIndex: blockIndex(),
				delta: JSON.stringify(toolCall.arguments),
				partial: output,
			});
			stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
		}
	}

	if (candidate?.finishReason) {
		output.stopReason = mapStopReasonString(candidate.finishReason);
		if (output.content.some((block) => block.type === "toolCall")) output.stopReason = "toolUse";
	}
	if (response.usageMetadata) {
		const cacheRead = response.usageMetadata.cachedContentTokenCount ?? 0;
		output.usage = {
			input: (response.usageMetadata.promptTokenCount ?? 0) - cacheRead,
			output: (response.usageMetadata.candidatesTokenCount ?? 0) + (response.usageMetadata.thoughtsTokenCount ?? 0),
			cacheRead,
			cacheWrite: 0,
			reasoning: response.usageMetadata.thoughtsTokenCount ?? 0,
			totalTokens: response.usageMetadata.totalTokenCount ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(model, output.usage);
	}
}

async function consumeSse(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"google-gemini-cli">,
	options?: GoogleGeminiCliOptions,
): Promise<boolean> {
	if (!response.body) throw new Error("Cloud Code Assist returned no response body");
	const state = { currentBlock: null as TextContent | ThinkingContent | null, started: false, hasContent: false };
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];

	const flushEvent = () => {
		if (dataLines.length === 0) return;
		const json = dataLines.join("\n");
		dataLines = [];
		try {
			processChunk(JSON.parse(json) as CloudCodeAssistChunk, output, stream, state, model);
		} catch {
			// Ignore malformed SSE events and continue with the stream.
		}
	};

	try {
		for (;;) {
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			const lines = buffer.split(/\r?\n/);
			buffer = done ? "" : (lines.pop() ?? "");
			for (const line of lines) {
				if (line === "") flushEvent();
				else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
			}
			if (done) break;
		}
		if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
		flushEvent();
	} finally {
		if (options?.signal?.aborted) await reader.cancel().catch(() => {});
	}

	if (state.currentBlock?.type === "text") {
		stream.push({
			type: "text_end",
			contentIndex: output.content.length - 1,
			content: state.currentBlock.text,
			partial: output,
		});
	} else if (state.currentBlock?.type === "thinking") {
		stream.push({
			type: "thinking_end",
			contentIndex: output.content.length - 1,
			content: state.currentBlock.thinking,
			partial: output,
		});
	}
	return state.hasContent;
}

export const stream: StreamFunction<"google-gemini-cli", GoogleGeminiCliOptions> = (
	model,
	context,
	options,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "google-gemini-cli" as Api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		try {
			const { token, projectId } = parseCredential(options?.apiKey);
			let payload = buildGoogleGeminiCliRequest(model, context, projectId, options);
			const transformed = await options?.onPayload?.(payload, model);
			if (transformed !== undefined) payload = transformed as CloudCodeAssistRequest;
			const customHeaders = providerHeadersToRecord({ ...model.headers, ...options?.headers });
			const headers = {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...ANTIGRAVITY_HEADERS,
				...customHeaders,
			};
			const endpoint = model.baseUrl?.trim() || DEFAULT_ENDPOINT;
			const response = await requestStream(
				`${endpoint}/v1internal:streamGenerateContent?alt=sse`,
				headers,
				JSON.stringify(payload),
				model,
				options,
			);
			if (!(await consumeSse(response, output, stream, model, options))) {
				throw new Error("Cloud Code Assist API returned an empty response");
			}
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error("Cloud Code Assist returned an error finish reason");
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-gemini-cli", SimpleStreamOptions> = (
	model,
	context,
	options,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } });
	}

	const effort = clampReasoning(options.reasoning)!;
	if (isGemini3Family(model.id, model.name)) {
		return stream(model, context, {
			...base,
			thinking: { enabled: true, level: thinkingLevel(model.id, model.name, effort) },
		});
	}

	const adjusted = adjustMaxTokensForThinking(options.maxTokens, model.maxTokens, effort, options.thinkingBudgets);
	return stream(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinking: { enabled: true, budgetTokens: adjusted.thinkingBudget },
	});
};
