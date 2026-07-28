import type { AssistantMessage, AuthResult, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	collectProviderRecentUsage,
	formatProviderUsageReport,
	type ProviderUsageReportEntry,
	queryProviderQuota,
} from "../src/core/provider-usage.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

function usage(tokens: number, cost = 0): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistantEntry(provider: string, tokens: number, timestamp: number): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider,
		model: "test",
		usage: usage(tokens, tokens / 1000),
		stopReason: "stop",
		timestamp,
	};
	return {
		type: "message",
		id: `${provider}-${timestamp}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message,
	};
}

function oauth(apiKey: string): AuthResult {
	return { auth: { apiKey }, source: "OAuth" };
}

describe("provider usage", () => {
	it("keeps active providers with no usage and puts the most-used provider last", () => {
		const result = collectProviderRecentUsage(
			[assistantEntry("heavy", 100, 2), assistantEntry("light", 10, 1), assistantEntry("heavy", 50, 3)],
			["heavy", "unused", "light", "heavy"],
		);

		expect(result.map((entry) => entry.providerId)).toEqual(["unused", "light", "heavy"]);
		expect(result.at(-1)).toMatchObject({ requests: 2, tokens: 150, lastUsedAt: 3 });
		expect(result.at(-1)?.cost).toBeCloseTo(0.15);
	});

	it("reads Codex remaining quota windows from the first-party endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 2_000 },
							secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: 3_000 },
						},
					}),
					{ status: 200 },
				),
		);

		const result = await queryProviderQuota("openai-codex", oauth("not-a-jwt"), { fetch: fetchMock });

		expect(result.status).toBe("available");
		expect(result.windows).toEqual([
			{ label: "5h", usedPercent: 25, remainingPercent: 75, resetAt: 2_000_000 },
			{ label: "Weekly", usedPercent: 60, remainingPercent: 40, resetAt: 3_000_000 },
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/codex/usage",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer not-a-jwt" }) }),
		);
	});

	it("reads Anthropic OAuth usage and rejects API-key quota guesses", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ limits: [{ kind: "session", percent: 30, resets_at: "2026-01-01T00:00:00Z" }] }),
					{ status: 200 },
				),
		);
		const oauthResult = await queryProviderQuota("anthropic", oauth("claude-token"), { fetch: fetchMock });
		const apiKeyResult = await queryProviderQuota(
			"anthropic",
			{ auth: { apiKey: "api-key" }, source: "ANTHROPIC_API_KEY" },
			{ fetch: fetchMock },
		);

		expect(oauthResult.windows[0]).toMatchObject({ label: "5h", usedPercent: 30, remainingPercent: 70 });
		expect(apiKeyResult).toMatchObject({ status: "unsupported", windows: [] });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reads Gemini CLI per-model remaining quota", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						buckets: [
							{
								modelId: "gemini-3-pro",
								tokenType: "REQUESTS",
								remainingFraction: 0.2,
								resetTime: "2026-01-02T00:00:00Z",
							},
						],
					}),
					{ status: 200 },
				),
		);
		const credential = JSON.stringify({ token: "google-token", projectId: "project-1" });

		const result = await queryProviderQuota("google-gemini-cli", oauth(credential), { fetch: fetchMock });

		expect(result.windows[0]).toMatchObject({
			label: "gemini-3-pro requests",
			usedPercent: 80,
			remainingPercent: 20,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ project: "project-1" }) }),
		);
	});

	it("reports unsupported providers honestly and preserves display order", async () => {
		const quota = await queryProviderQuota("custom-provider", undefined, { fetch: vi.fn() });
		const entries: ProviderUsageReportEntry[] = [
			{
				providerId: "light",
				displayName: "Light",
				recent: { providerId: "light", requests: 1, tokens: 10, cost: 0, lastUsedAt: 1_000 },
				quota,
			},
			{
				providerId: "heavy",
				displayName: "Heavy",
				recent: { providerId: "heavy", requests: 2, tokens: 100, cost: 1, lastUsedAt: 2_000 },
				quota: { ...quota, providerId: "heavy" },
			},
		];

		const report = formatProviderUsageReport(entries, 3_000);
		expect(quota.status).toBe("unsupported");
		expect(report.indexOf("Light (light)")).toBeLessThan(report.indexOf("Heavy (heavy)"));
		expect(report).toContain("100 tokens");
	});
});
