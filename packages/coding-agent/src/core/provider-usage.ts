import type { AuthResult } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

export interface ProviderRecentUsage {
	providerId: string;
	requests: number;
	tokens: number;
	cost: number;
	lastUsedAt?: number;
}

export interface ProviderQuotaWindow {
	label: string;
	usedPercent: number;
	remainingPercent: number;
	resetAt?: number;
}

export interface ProviderQuotaSnapshot {
	providerId: string;
	status: "available" | "unsupported" | "unavailable";
	windows: ProviderQuotaWindow[];
	message?: string;
}

export interface ProviderUsageReportEntry {
	providerId: string;
	displayName: string;
	recent: ProviderRecentUsage;
	quota: ProviderQuotaSnapshot;
}

export interface ProviderQuotaQueryOptions {
	fetch?: typeof fetch;
	now?: number;
}

/**
 * Aggregate persisted assistant-message usage for active providers in the current
 * session and order it from least to most recently consumed tokens.
 */
export function collectProviderRecentUsage(
	entries: readonly SessionEntry[],
	activeProviderIds: readonly string[],
): ProviderRecentUsage[] {
	const usageByProvider = new Map<string, ProviderRecentUsage>();

	for (const providerId of activeProviderIds) {
		if (!usageByProvider.has(providerId)) {
			usageByProvider.set(providerId, {
				providerId,
				requests: 0,
				tokens: 0,
				cost: 0,
			});
		}
	}

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const usage = usageByProvider.get(entry.message.provider);
		if (!usage) continue;

		usage.requests += 1;
		usage.tokens +=
			entry.message.usage.input +
			entry.message.usage.output +
			entry.message.usage.cacheRead +
			entry.message.usage.cacheWrite;
		usage.cost += entry.message.usage.cost.total;
		usage.lastUsedAt = Math.max(usage.lastUsedAt ?? 0, entry.message.timestamp);
	}

	return [...usageByProvider.values()].sort(
		(a, b) => a.tokens - b.tokens || a.requests - b.requests || a.providerId.localeCompare(b.providerId),
	);
}

const QUOTA_ENDPOINTS = {
	anthropic: "https://api.anthropic.com/api/oauth/usage",
	"google-gemini-cli": "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
	"openai-codex": "https://chatgpt.com/backend-api/wham/usage",
} as const;

interface CodexWindowResponse {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
}

interface CodexUsageResponse {
	rate_limit?: {
		primary_window?: CodexWindowResponse;
		secondary_window?: CodexWindowResponse;
	};
	additional_rate_limits?: Array<{
		limit_name?: string;
		metered_feature?: string;
		rate_limit?: {
			primary_window?: CodexWindowResponse;
			secondary_window?: CodexWindowResponse;
		};
	}>;
}

interface AnthropicUsageResponse {
	limits?: Array<{
		kind?: string;
		percent?: number;
		resets_at?: string;
		scope?: { model?: { display_name?: string | null } | null } | null;
	}>;
}

interface GeminiQuotaResponse {
	buckets?: Array<{
		modelId?: string;
		tokenType?: string;
		remainingFraction?: number;
		resetTime?: string;
	}>;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function resetTimestamp(value: string | number | undefined, seconds = false): number | undefined {
	if (value === undefined) return undefined;
	const timestamp = typeof value === "number" ? value * (seconds ? 1000 : 1) : Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function codexWindowLabel(window: CodexWindowResponse): string {
	const seconds = window.limit_window_seconds;
	if (!seconds || !Number.isFinite(seconds)) return "Quota";
	const hours = seconds / 3600;
	if (hours >= 24) {
		const days = Math.round(hours / 24);
		return days === 7 ? "Weekly" : `${days}d`;
	}
	return `${Math.round(hours)}h`;
}

function codexWindow(window: CodexWindowResponse, label?: string): ProviderQuotaWindow | undefined {
	if (typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return undefined;
	const usedPercent = clampPercent(window.used_percent);
	return {
		label: label ?? codexWindowLabel(window),
		usedPercent,
		remainingPercent: 100 - usedPercent,
		resetAt: resetTimestamp(window.reset_at, true),
	};
}

function parseCodexQuota(providerId: string, value: CodexUsageResponse): ProviderQuotaSnapshot {
	const windows: ProviderQuotaWindow[] = [];
	for (const window of [value.rate_limit?.primary_window, value.rate_limit?.secondary_window]) {
		if (!window) continue;
		const parsed = codexWindow(window);
		if (parsed) windows.push(parsed);
	}
	for (const additional of value.additional_rate_limits ?? []) {
		const name = additional.limit_name ?? additional.metered_feature ?? "Additional";
		for (const window of [additional.rate_limit?.primary_window, additional.rate_limit?.secondary_window]) {
			if (!window) continue;
			const parsed = codexWindow(window, `${name} ${codexWindowLabel(window)}`);
			if (parsed) windows.push(parsed);
		}
	}
	return windows.length > 0
		? { providerId, status: "available", windows }
		: { providerId, status: "unavailable", windows: [], message: "The provider returned no quota windows." };
}

function anthropicLimitLabel(limit: NonNullable<AnthropicUsageResponse["limits"]>[number]): string {
	if (limit.kind === "session") return "5h";
	if (limit.kind === "weekly_all") return "Weekly";
	if (limit.kind === "weekly_scoped") return `${limit.scope?.model?.display_name ?? "Scoped"} weekly`;
	return limit.kind ?? "Quota";
}

function parseAnthropicQuota(providerId: string, value: AnthropicUsageResponse): ProviderQuotaSnapshot {
	const windows = (value.limits ?? []).flatMap((limit): ProviderQuotaWindow[] => {
		if (typeof limit.percent !== "number" || !Number.isFinite(limit.percent)) return [];
		const usedPercent = clampPercent(limit.percent);
		return [
			{
				label: anthropicLimitLabel(limit),
				usedPercent,
				remainingPercent: 100 - usedPercent,
				resetAt: resetTimestamp(limit.resets_at),
			},
		];
	});
	return windows.length > 0
		? { providerId, status: "available", windows }
		: { providerId, status: "unavailable", windows: [], message: "The provider returned no quota windows." };
}

function parseGeminiQuota(providerId: string, value: GeminiQuotaResponse): ProviderQuotaSnapshot {
	const windows = (value.buckets ?? []).flatMap((bucket): ProviderQuotaWindow[] => {
		if (typeof bucket.remainingFraction !== "number" || !Number.isFinite(bucket.remainingFraction)) return [];
		const remainingPercent = clampPercent(bucket.remainingFraction * 100);
		const tokenType = bucket.tokenType ? ` ${bucket.tokenType.toLowerCase()}` : "";
		return [
			{
				label: `${bucket.modelId ?? "Model"}${tokenType}`,
				usedPercent: 100 - remainingPercent,
				remainingPercent,
				resetAt: resetTimestamp(bucket.resetTime),
			},
		];
	});
	return windows.length > 0
		? { providerId, status: "available", windows }
		: { providerId, status: "unavailable", windows: [], message: "The provider returned no quota buckets." };
}

function decodeCodexAccountId(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		const auth = payload["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
		return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

async function quotaResponse(
	providerId: string,
	url: string,
	init: RequestInit,
	fetchImpl: typeof fetch,
): Promise<Response | ProviderQuotaSnapshot> {
	try {
		const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) {
			return {
				providerId,
				status: "unavailable",
				windows: [],
				message: `Quota request failed (HTTP ${response.status}).`,
			};
		}
		return response;
	} catch (error) {
		const message =
			error instanceof Error && error.name === "TimeoutError" ? "Quota request timed out." : "Quota request failed.";
		return { providerId, status: "unavailable", windows: [], message };
	}
}

async function parseQuotaResponse<T>(
	providerId: string,
	response: Response,
	parser: (providerId: string, value: T) => ProviderQuotaSnapshot,
): Promise<ProviderQuotaSnapshot> {
	try {
		return parser(providerId, (await response.json()) as T);
	} catch {
		return { providerId, status: "unavailable", windows: [], message: "The quota response was invalid." };
	}
}

/**
 * Query a provider's supported first-party quota endpoint without exposing its
 * resolved credential. Unsupported providers return an explicit status rather
 * than an invented remaining allowance.
 */
export async function queryProviderQuota(
	providerId: string,
	auth: AuthResult | undefined,
	options: ProviderQuotaQueryOptions = {},
): Promise<ProviderQuotaSnapshot> {
	if (!(providerId in QUOTA_ENDPOINTS)) {
		return {
			providerId,
			status: "unsupported",
			windows: [],
			message: "This provider does not expose a supported remaining-quota endpoint.",
		};
	}

	const credential = auth?.auth.apiKey;
	if (!credential) {
		return { providerId, status: "unavailable", windows: [], message: "No active credential is available." };
	}
	const fetchImpl = options.fetch ?? fetch;

	if (providerId === "openai-codex") {
		const accountId = decodeCodexAccountId(credential);
		const response = await quotaResponse(
			providerId,
			QUOTA_ENDPOINTS[providerId],
			{
				headers: {
					Authorization: `Bearer ${credential}`,
					...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
					"User-Agent": "codex-cli",
					Accept: "application/json",
				},
			},
			fetchImpl,
		);
		if (!(response instanceof Response)) return response;
		return parseQuotaResponse(providerId, response, parseCodexQuota);
	}

	if (providerId === "anthropic") {
		if (auth?.source !== "OAuth") {
			return {
				providerId,
				status: "unsupported",
				windows: [],
				message: "Remaining subscription quota is available only with Anthropic OAuth.",
			};
		}
		const response = await quotaResponse(
			providerId,
			QUOTA_ENDPOINTS[providerId],
			{
				headers: {
					Authorization: `Bearer ${credential}`,
					"anthropic-beta": "oauth-2025-04-20",
					Accept: "application/json",
				},
			},
			fetchImpl,
		);
		if (!(response instanceof Response)) return response;
		return parseQuotaResponse(providerId, response, parseAnthropicQuota);
	}

	let googleCredential: { token?: string; projectId?: string };
	try {
		googleCredential = JSON.parse(credential) as { token?: string; projectId?: string };
	} catch {
		return { providerId, status: "unavailable", windows: [], message: "Google OAuth credentials are invalid." };
	}
	if (!googleCredential.token || !googleCredential.projectId) {
		return { providerId, status: "unavailable", windows: [], message: "Google OAuth credentials are incomplete." };
	}
	const response = await quotaResponse(
		providerId,
		QUOTA_ENDPOINTS["google-gemini-cli"],
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${googleCredential.token}`,
				"Content-Type": "application/json",
				"User-Agent": "antigravity/1.1.5 linux/x64",
			},
			body: JSON.stringify({ project: googleCredential.projectId }),
		},
		fetchImpl,
	);
	if (!(response instanceof Response)) return response;
	return parseQuotaResponse(providerId, response, parseGeminiQuota);
}

/**
 * Render compact quota and recent-session tables in least-to-most-used provider
 * order. Equivalent unused per-model quota buckets are grouped into one row,
 * while every model with non-zero usage remains visible on its own row. Reset
 * times use short countdowns, and the heaviest provider remains at the bottom.
 */
export function formatProviderUsageReport(entries: readonly ProviderUsageReportEntry[], now = Date.now()): string {
	const quotaRows: string[][] = [];
	const recentRows: string[][] = [];

	for (const entry of entries) {
		const provider = entry.displayName || entry.providerId;
		const groups = entry.quota.status === "available" ? groupQuotaWindows(entry.quota.windows) : [];
		if (groups.length === 0) {
			quotaRows.push([provider, formatQuotaStatus(entry.quota), "—", "—", "—"]);
		} else {
			groups.forEach((group, index) => {
				quotaRows.push([
					index === 0 ? provider : "",
					formatQuotaLabels(entry.providerId, group.labels),
					formatPercentage(group.window.remainingPercent),
					formatPercentage(group.window.usedPercent),
					formatReset(group.window.resetAt, now),
				]);
			});
		}

		recentRows.push([
			provider,
			formatInteger(entry.recent.requests),
			formatInteger(entry.recent.tokens),
			formatLastUsed(entry.recent.lastUsedAt, now),
		]);
	}

	return [
		"Provider Quota",
		renderPlainTable(["PROVIDER", "QUOTA", "LEFT", "USED", "RESET"], quotaRows, [28, 24, 8, 8, 12], new Set([2, 3])),
		"",
		"Recent Session Usage (least → most used)",
		renderPlainTable(["PROVIDER", "REQUESTS", "TOKENS", "LAST USED"], recentRows, [28, 10, 14, 12], new Set([1, 2])),
	].join("\n");
}

interface QuotaWindowGroup {
	window: ProviderQuotaWindow;
	labels: string[];
}

function groupQuotaWindows(windows: readonly ProviderQuotaWindow[]): QuotaWindowGroup[] {
	const groups = new Map<string, QuotaWindowGroup>();
	for (const window of windows) {
		const key =
			window.usedPercent > 0
				? `nonzero:${groups.size}`
				: `${window.remainingPercent}|${window.usedPercent}|${window.resetAt ?? ""}`;
		const current = groups.get(key);
		if (current) current.labels.push(window.label);
		else groups.set(key, { window, labels: [window.label] });
	}
	return [...groups.values()].sort(
		(a, b) =>
			a.window.usedPercent - b.window.usedPercent ||
			(a.window.resetAt ?? Number.POSITIVE_INFINITY) - (b.window.resetAt ?? Number.POSITIVE_INFINITY),
	);
}

function formatQuotaLabels(providerId: string, labels: readonly string[]): string {
	const uniqueLabels = [...new Set(labels)];
	if (providerId === "google-gemini-cli") {
		return uniqueLabels.length === 1
			? uniqueLabels[0].replace(/\s+(?:wtus|requests|tokens)$/i, "")
			: `${uniqueLabels.length} models`;
	}
	return uniqueLabels.length <= 2 ? uniqueLabels.join(", ") : `${uniqueLabels.length} limits`;
}

function formatQuotaStatus(quota: ProviderQuotaSnapshot): string {
	if (quota.status === "unsupported") return "unsupported";
	const httpStatus = quota.message?.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
	return httpStatus ? `unavailable (HTTP ${httpStatus})` : "unavailable";
}

function renderPlainTable(
	headers: readonly string[],
	rows: readonly (readonly string[])[],
	caps: readonly number[],
	rightAligned: ReadonlySet<number>,
): string {
	const widths = headers.map((header, index) => {
		const contentWidth = Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length));
		return Math.min(contentWidth, caps[index] ?? contentWidth);
	});
	const renderRow = (row: readonly string[]) =>
		row
			.map((value, index) => {
				const cell = truncateTableCell(value ?? "", widths[index]);
				return rightAligned.has(index) ? cell.padStart(widths[index]) : cell.padEnd(widths[index]);
			})
			.join(" | ")
			.trimEnd();
	const separator = widths.map((width) => "-".repeat(width)).join("-+-");
	return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}

function truncateTableCell(value: string, width: number): string {
	const normalized = value.replace(/[\r\n\t]+/g, " ");
	if (normalized.length <= width) return normalized;
	return width <= 1 ? normalized.slice(0, width) : `${normalized.slice(0, width - 1)}…`;
}

function formatPercentage(value: number): string {
	return Number.isFinite(value) ? `${Number(value.toFixed(2))}%` : "?";
}

function formatInteger(value: number): string {
	return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "?";
}

function formatLastUsed(timestamp: number | undefined, now: number): string {
	if (timestamp === undefined) return "never";
	if (!Number.isFinite(timestamp)) return "?";
	return now <= timestamp ? "now" : `${formatDuration(now - timestamp)} ago`;
}

function formatReset(resetAt: number | undefined, now: number): string {
	if (resetAt === undefined || !Number.isFinite(resetAt)) return "—";
	return resetAt <= now ? "now" : formatDuration(resetAt - now);
}

function formatDuration(milliseconds: number): string {
	const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}
