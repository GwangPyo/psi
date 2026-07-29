/**
 * Google OAuth for the Antigravity Cloud Code Assist backend used by agy.
 *
 * This module is Node/Bun-only because browser login uses a loopback callback
 * server. It is loaded lazily by the provider so browser bundles do not pull in
 * node:http.
 */

import type { Server } from "node:http";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

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

type CallbackServer = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string } | null>;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const decode = (value: string) => atob(value);
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const MANUAL_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const CALLBACK_PATH = "/oauth2callback";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const ONBOARD_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const CODE_ASSIST_REQUEST_TIMEOUT_MS = 45_000;
const USER_INFO_REQUEST_TIMEOUT_MS = 10_000;
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const GOOGLE_BROWSER_LOGIN_METHOD = "browser";
const GOOGLE_MANUAL_LOGIN_METHOD = "manual_code";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/aicode",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Google Gemini CLI OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({ createServer: httpModule.createServer }));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function createState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

function callbackPort(): number {
	const raw = getProviderEnvValue("OAUTH_CALLBACK_PORT");
	if (!raw) return 0;
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid OAUTH_CALLBACK_PORT: ${raw}`);
	}
	return port;
}

function callbackHost(): string {
	return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || getProviderEnvValue("OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

async function startCallbackServer(expectedState: string): Promise<CallbackServer> {
	const { createServer } = await getNodeApis();
	let settleWait: ((value: { code: string } | null) => void) | undefined;
	const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	const server = createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://127.0.0.1");
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}

			const oauthError = url.searchParams.get("error");
			if (oauthError) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Google authentication did not complete.", oauthError));
				settleWait?.(null);
				return;
			}
			if (url.searchParams.get("state") !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("OAuth state mismatch."));
				return;
			}

			const code = url.searchParams.get("code");
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Missing authorization code."));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthSuccessHtml("Google authentication completed. You can close this window."));
			settleWait?.({ code });
		} catch {
			res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthErrorHtml("Internal error while processing the OAuth callback."));
		}
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(callbackPort(), callbackHost(), () => {
			server.removeListener("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not determine Google OAuth callback port"));
				return;
			}
			resolve({
				server,
				redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
				cancelWait: () => settleWait?.(null),
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

function buildAuthorizationUrl(input: { challenge: string; redirectUri: string; state: string }): string {
	const url = new URL(AUTH_URL);
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("scope", SCOPES.join(" "));
	url.searchParams.set("code_challenge", input.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", input.state);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	return url.toString();
}

function authorizationCodeFromInput(input: string, expectedState: string): string {
	const trimmed = input.trim();
	try {
		const redirect = new URL(trimmed);
		if (redirect.searchParams.get("state") !== expectedState) throw new Error("OAuth state mismatch");
		return redirect.searchParams.get("code") || "";
	} catch (error) {
		if (error instanceof Error && error.message === "OAuth state mismatch") throw error;
		return trimmed;
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

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string,
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
				redirect_uri: redirectUri,
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

/** Complete headless Google OAuth by accepting the failed loopback redirect URL from the remote browser. */
async function loginWithManualCode(interaction: AuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const state = createState();
	const url = buildAuthorizationUrl({ challenge, redirectUri: MANUAL_REDIRECT_URI, state });
	interaction.notify({
		type: "auth_url",
		url,
		instructions:
			"Open this URL and approve access. If the localhost page does not load, copy its full URL from the browser address bar.",
	});
	const input = await interaction.prompt({
		type: "manual_code",
		message: "Paste the final localhost redirect URL or Google authorization code:",
		signal: interaction.signal,
	});
	const code = authorizationCodeFromInput(input, state);
	if (!code) throw new Error("Google authorization code is required");
	return credentialFromToken(
		await exchangeAuthorizationCode(code, verifier, MANUAL_REDIRECT_URI, interaction.signal),
		interaction,
	);
}

async function loginWithBrowser(interaction: AuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const state = createState();
	const callback = await startCallbackServer(state);
	const manualAbort = new AbortController();
	let manualCode: string | undefined;
	let manualError: Error | undefined;

	interaction.notify({
		type: "auth_url",
		url: buildAuthorizationUrl({ challenge, redirectUri: callback.redirectUri, state }),
		instructions: "Complete Google sign-in in your browser.",
	});

	try {
		const manualPromise = interaction
			.prompt({
				type: "manual_code",
				message: "Complete login in your browser, or paste the authorization code here:",
				placeholder: callback.redirectUri,
				signal: manualAbort.signal,
			})
			.then((value) => {
				manualCode = value.trim();
				callback.cancelWait();
			})
			.catch((error) => {
				if (!manualAbort.signal.aborted) {
					manualError = error instanceof Error ? error : new Error(String(error));
				}
				callback.cancelWait();
			});

		const result = await callback.waitForCode();
		if (manualError) throw manualError;
		let code = result?.code || (manualCode ? authorizationCodeFromInput(manualCode, state) : undefined);
		if (result?.code) manualAbort.abort();
		if (!code) {
			await manualPromise;
			if (manualError) throw manualError;
			code = manualCode ? authorizationCodeFromInput(manualCode, state) : undefined;
		}
		if (!code) throw new Error("Missing Google authorization code");
		return credentialFromToken(
			await exchangeAuthorizationCode(code, verifier, callback.redirectUri, interaction.signal),
			interaction,
		);
	} finally {
		manualAbort.abort();
		callback.server.close();
	}
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

	async login(interaction) {
		const method = await interaction.prompt({
			type: "select",
			message: "Select Google login method:",
			options: [
				{ id: GOOGLE_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				{ id: GOOGLE_MANUAL_LOGIN_METHOD, label: "Authorization code (headless)" },
			],
		});
		if (method === GOOGLE_MANUAL_LOGIN_METHOD) return loginWithManualCode(interaction);
		if (method !== GOOGLE_BROWSER_LOGIN_METHOD) throw new Error(`Unknown Google login method: ${method}`);
		return loginWithBrowser(interaction);
	},

	refresh: refreshGoogleToken,

	async toAuth(credential) {
		const projectId = credential.projectId;
		if (typeof projectId !== "string" || !projectId) {
			throw new Error("Google Cloud Code Assist credentials are missing projectId; log in again");
		}
		return { apiKey: JSON.stringify({ token: credential.access, projectId }) };
	},
};
