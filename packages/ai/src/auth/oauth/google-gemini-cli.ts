/** Google OAuth for the Antigravity Cloud Code Assist backend used by agy. */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "../types.ts";
import { generatePKCE } from "./pkce.ts";

type GoogleTokenResponse = {
	access_token?: string;
	expires_in?: number;
	refresh_token?: string;
};

type LoadCodeAssistResponse = {
	cloudaicompanionProject?: string | { id?: string } | null;
	currentTier?: { id?: string; userDefinedCloudaicompanionProject?: boolean | null } | null;
	allowedTiers?: Array<{
		id?: string;
		isDefault?: boolean;
		userDefinedCloudaicompanionProject?: boolean | null;
	}> | null;
	ineligibleTiers?: Array<{ reasonMessage?: string; validationErrorMessage?: string }> | null;
};

type LongRunningOperationResponse = {
	name?: string;
	done?: boolean;
	error?: { message?: string };
	response?: { cloudaicompanionProject?: { id?: string } };
};

const decode = (value: string) => atob(value);
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const REDIRECT_URI = "https://antigravity.google/oauth-callback";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const ONBOARD_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const CODE_ASSIST_REQUEST_TIMEOUT_MS = 45_000;
const USER_INFO_REQUEST_TIMEOUT_MS = 10_000;
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

async function fetchWithTimeout(
	input: string,
	init: RequestInit,
	timeoutMs: number,
	operation: string,
): Promise<Response> {
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort(init.signal?.reason);
	if (init.signal?.aborted) onAbort();
	else init.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} catch (error) {
		if (timedOut) throw new Error(`${operation} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
		if (init.signal?.aborted) throw new Error("Login cancelled");
		throw error;
	} finally {
		clearTimeout(timeout);
		init.signal?.removeEventListener("abort", onAbort);
	}
}

async function readTokenResponse(response: Response, operation: "exchange" | "refresh"): Promise<GoogleTokenResponse> {
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Google OAuth token ${operation} failed (${response.status}): ${body || response.statusText}`);
	}
	const data = (await response.json()) as GoogleTokenResponse;
	if (!data.access_token || typeof data.expires_in !== "number") {
		throw new Error(`Google OAuth token ${operation} response is missing required fields`);
	}
	return data;
}

function createState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildAuthorizationUrl(challenge: string, state: string): string {
	const url = new URL(AUTH_URL);
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPES.join(" "));
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	return url.toString();
}

function authorizationCodeFromInput(input: string, expectedState: string): string {
	const trimmed = input.trim();
	try {
		const redirect = new URL(trimmed);
		const state = redirect.searchParams.get("state");
		if (state && state !== expectedState) throw new Error("OAuth state mismatch");
		return redirect.searchParams.get("code") || "";
	} catch (error) {
		if (error instanceof Error && error.message === "OAuth state mismatch") throw error;
		try {
			return decodeURIComponent(trimmed);
		} catch {
			throw new Error("Google authorization code has invalid URL encoding");
		}
	}
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	signal?: AbortSignal,
): Promise<GoogleTokenResponse> {
	const response = await fetchWithTimeout(
		TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				code,
				code_verifier: verifier,
				grant_type: "authorization_code",
				redirect_uri: REDIRECT_URI,
			}),
			signal,
		},
		OAUTH_REQUEST_TIMEOUT_MS,
		"Google OAuth token exchange",
	);
	return readTokenResponse(response, "exchange");
}

function codeAssistHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "antigravity/1.1.5 linux/x64",
	};
}

function projectIdFromResponse(data: LoadCodeAssistResponse): string | undefined {
	if (typeof data.cloudaicompanionProject === "string") return data.cloudaicompanionProject || undefined;
	return data.cloudaicompanionProject?.id;
}

function configuredProjectId(): string | undefined {
	return getProviderEnvValue("GOOGLE_CLOUD_PROJECT") || getProviderEnvValue("GOOGLE_CLOUD_PROJECT_ID");
}

function eligibilityError(data: LoadCodeAssistResponse): string | undefined {
	for (const tier of data.ineligibleTiers ?? []) {
		const message = tier.validationErrorMessage || tier.reasonMessage;
		if (message) return message;
	}
	return undefined;
}

async function pollOperation(
	name: string,
	headers: Record<string, string>,
	interaction: AuthInteraction,
): Promise<LongRunningOperationResponse> {
	const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
	let attempt = 0;
	while (Date.now() < deadline) {
		if (interaction.signal?.aborted) throw new Error("Login cancelled");
		if (attempt > 0) {
			interaction.notify({ type: "progress", message: "Waiting for Google Cloud project provisioning..." });
			await new Promise((resolve) => setTimeout(resolve, 5000));
		}
		const response = await fetchWithTimeout(
			`${CODE_ASSIST_ENDPOINT}/v1internal/${name}`,
			{
				headers,
				signal: interaction.signal,
			},
			CODE_ASSIST_REQUEST_TIMEOUT_MS,
			"Google Cloud project provisioning check",
		);
		if (!response.ok) {
			throw new Error(`Google Cloud project provisioning check failed (${response.status})`);
		}
		const operation = (await response.json()) as LongRunningOperationResponse;
		if (operation.done) return operation;
		attempt++;
	}
	throw new Error("Google Cloud project provisioning timed out");
}

async function discoverProject(accessToken: string, interaction: AuthInteraction): Promise<string> {
	const projectId = configuredProjectId();
	const headers = codeAssistHeaders(accessToken);
	interaction.notify({ type: "progress", message: "Checking Google Antigravity access..." });

	const response = await fetchWithTimeout(
		`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				cloudaicompanionProject: projectId,
				metadata: {
					ideType: "IDE_UNSPECIFIED",
					platform: "PLATFORM_UNSPECIFIED",
					pluginType: "GEMINI",
					duetProject: projectId,
				},
			}),
			signal: interaction.signal,
		},
		CODE_ASSIST_REQUEST_TIMEOUT_MS,
		"Google Cloud Code Assist access check",
	);
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const iamHint =
			response.status === 403 ? " Check the Cloud AI Companion User and Service Usage Consumer roles." : "";
		throw new Error(
			`Google Cloud Code Assist access check failed (${response.status}): ${body || response.statusText}.${iamHint}`,
		);
	}

	const data = (await response.json()) as LoadCodeAssistResponse;
	const resolvedProjectId = projectIdFromResponse(data) || projectId;
	if (resolvedProjectId) {
		interaction.notify({ type: "progress", message: "Google Antigravity access verified." });
		return resolvedProjectId;
	}
	if (data.currentTier) {
		throw new Error(
			"This Google account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to use Code Assist.",
		);
	}

	const tier = data.allowedTiers?.find((candidate) => candidate.isDefault) ?? data.allowedTiers?.[0];
	const tierId = tier?.id ?? TIER_LEGACY;
	if (tierId !== TIER_FREE && !projectId) {
		throw new Error(
			eligibilityError(data) ??
				"This Google account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to use Code Assist.",
		);
	}

	interaction.notify({ type: "progress", message: "Provisioning Google Cloud Code Assist access..." });
	const onboardResponse = await fetchWithTimeout(
		`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				tierId,
				cloudaicompanionProject: tierId === TIER_FREE ? undefined : projectId,
				metadata: {
					ideType: "IDE_UNSPECIFIED",
					platform: "PLATFORM_UNSPECIFIED",
					pluginType: "GEMINI",
					duetProject: tierId === TIER_FREE ? undefined : projectId,
				},
			}),
			signal: interaction.signal,
		},
		CODE_ASSIST_REQUEST_TIMEOUT_MS,
		"Google Cloud Code Assist onboarding",
	);
	if (!onboardResponse.ok) {
		const body = await onboardResponse.text().catch(() => "");
		throw new Error(`Google Cloud Code Assist onboarding failed (${onboardResponse.status}): ${body}`);
	}

	let operation = (await onboardResponse.json()) as LongRunningOperationResponse;
	if (!operation.done && operation.name) operation = await pollOperation(operation.name, headers, interaction);
	if (operation.error?.message)
		throw new Error(`Google Cloud Code Assist onboarding failed: ${operation.error.message}`);
	const provisionedProject = operation.response?.cloudaicompanionProject?.id;
	if (provisionedProject) {
		interaction.notify({ type: "progress", message: "Google Cloud Code Assist access provisioned." });
		return provisionedProject;
	}
	if (projectId) {
		interaction.notify({ type: "progress", message: "Google Cloud Code Assist access provisioned." });
		return projectId;
	}
	throw new Error("Google Cloud Code Assist did not return a project ID");
}

async function getUserEmail(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const response = await fetchWithTimeout(
			USER_INFO_URL,
			{
				headers: { Authorization: `Bearer ${accessToken}` },
				signal,
			},
			USER_INFO_REQUEST_TIMEOUT_MS,
			"Google user info request",
		);
		if (!response.ok) return undefined;
		const data = (await response.json()) as { email?: string };
		return data.email;
	} catch {
		return undefined;
	}
}

async function credentialFromToken(token: GoogleTokenResponse, interaction: AuthInteraction): Promise<OAuthCredential> {
	if (!token.refresh_token)
		throw new Error("Google OAuth did not return a refresh token. Revoke access and try again.");
	const projectId = await discoverProject(token.access_token!, interaction);
	const email = await getUserEmail(token.access_token!, interaction.signal);
	return {
		type: "oauth",
		access: token.access_token!,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in! * 1000 - REFRESH_SKEW_MS,
		projectId,
		...(email ? { accountId: email } : {}),
	};
}

async function loginWithAuthorizationCode(interaction: AuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const state = createState();
	interaction.notify({
		type: "auth_url",
		url: buildAuthorizationUrl(challenge, state),
		instructions: "Complete Google sign-in, then paste the authorization code shown by Antigravity.",
	});
	const input = await interaction.prompt({
		type: "manual_code",
		message: "Paste the Antigravity authorization code or final callback URL:",
		signal: interaction.signal,
	});
	const code = authorizationCodeFromInput(input, state);
	if (!code) throw new Error("Google authorization code is required");
	return credentialFromToken(await exchangeAuthorizationCode(code, verifier, interaction.signal), interaction);
}

async function refreshGoogleToken(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> {
	const projectId = credential.projectId;
	if (typeof projectId !== "string" || !projectId) {
		throw new Error("Google Cloud Code Assist credentials are missing projectId; log in again");
	}
	const response = await fetchWithTimeout(
		TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				refresh_token: credential.refresh,
				grant_type: "refresh_token",
			}),
			signal,
		},
		OAUTH_REQUEST_TIMEOUT_MS,
		"Google OAuth token refresh",
	);
	const token = await readTokenResponse(response, "refresh");
	return {
		...credential,
		access: token.access_token!,
		refresh: token.refresh_token || credential.refresh,
		expires: Date.now() + token.expires_in! * 1000 - REFRESH_SKEW_MS,
	};
}

export const googleGeminiCliOAuth: OAuthAuth = {
	name: "Google Antigravity",
	loginLabel: "Sign in with Google",

	login: loginWithAuthorizationCode,

	refresh: refreshGoogleToken,

	async toAuth(credential) {
		const projectId = credential.projectId;
		if (typeof projectId !== "string" || !projectId) {
			throw new Error("Google Cloud Code Assist credentials are missing projectId; log in again");
		}
		return { apiKey: JSON.stringify({ token: credential.access, projectId }) };
	},
};
