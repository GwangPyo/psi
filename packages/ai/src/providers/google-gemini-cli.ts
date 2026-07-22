import { googleGeminiCliApi } from "../api/google-gemini-cli.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadGoogleGeminiCliOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";

const CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const MODEL_LOOKUP_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_VERSION = "1.1.5";

interface AvailableModel {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	recommended?: boolean;
}

interface AvailableModelsResponse {
	models?: Record<string, AvailableModel>;
	defaultAgentModelId?: string;
	agentModelSorts?: Array<{ groups?: Array<{ modelIds?: string[] }> }>;
}

function displayModelName(modelId: string): string {
	return modelId
		.split("-")
		.map((part) => (/^\d+(?:\.\d+)*$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");
}

function availableModel(modelId: string, metadata: AvailableModel): Model<"google-gemini-cli"> {
	return {
		id: modelId,
		name: metadata.displayName || displayModelName(modelId),
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: CODE_ASSIST_ENDPOINT,
		reasoning: metadata.supportsThinking === true,
		input: metadata.supportsImages === true ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: metadata.maxTokens ?? 1_048_576,
		maxTokens: metadata.maxOutputTokens ?? 65_536,
	};
}

function orderedAgentModelIds(response: AvailableModelsResponse): string[] {
	const serverOrder = response.agentModelSorts?.flatMap(
		(sort) => sort.groups?.flatMap((group) => group.modelIds ?? []) ?? [],
	);
	if (serverOrder?.length) return [...new Set(serverOrder)];

	return Object.entries(response.models ?? {})
		.filter(([, metadata]) => metadata.recommended && metadata.displayName)
		.map(([modelId]) => modelId);
}

async function lookupModels(context: RefreshModelsContext): Promise<readonly Model<"google-gemini-cli">[]> {
	if (context.credential?.type !== "oauth") return [];
	const projectId = context.credential.projectId;
	if (typeof projectId !== "string" || !projectId) {
		throw new Error("Google Antigravity credentials are missing projectId; log in again");
	}

	const timeout = new AbortController();
	const relayAbort = () => timeout.abort(context.signal?.reason);
	if (context.signal?.aborted) relayAbort();
	else context.signal?.addEventListener("abort", relayAbort, { once: true });
	const timer = setTimeout(() => timeout.abort(), MODEL_LOOKUP_TIMEOUT_MS);

	try {
		const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${context.credential.access}`,
				"Content-Type": "application/json",
				"User-Agent": `antigravity/${ANTIGRAVITY_VERSION} linux/x64`,
			},
			body: JSON.stringify({ project: projectId, requestId: `pi-${crypto.randomUUID()}` }),
			signal: timeout.signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Google Antigravity model lookup failed (${response.status}): ${body || response.statusText}`);
		}

		const data = (await response.json()) as AvailableModelsResponse;
		const models = data.models ?? {};
		const resolved = orderedAgentModelIds(data)
			.map((modelId) => (models[modelId] ? availableModel(modelId, models[modelId]) : undefined))
			.filter((model): model is Model<"google-gemini-cli"> => model !== undefined);
		if (resolved.length === 0) {
			throw new Error("Google Antigravity model lookup returned no available agent models");
		}
		return resolved;
	} catch (error) {
		if (context.signal?.aborted) throw new Error("Google Antigravity model lookup cancelled");
		if (timeout.signal.aborted) throw new Error("Google Antigravity model lookup timed out after 30 seconds");
		throw error;
	} finally {
		clearTimeout(timer);
		context.signal?.removeEventListener("abort", relayAbort);
	}
}

export function googleGeminiCliProvider(): Provider<"google-gemini-cli"> {
	return createProvider({
		id: "google-gemini-cli",
		name: "Google Antigravity (Gemini)",
		baseUrl: CODE_ASSIST_ENDPOINT,
		auth: {
			oauth: lazyOAuth({
				name: "Google Antigravity",
				loginLabel: "Sign in with Google",
				load: loadGoogleGeminiCliOAuth,
			}),
		},
		models: [],
		fetchModels: lookupModels,
		api: googleGeminiCliApi(),
	});
}
