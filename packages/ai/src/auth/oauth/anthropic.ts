/** Anthropic OAuth flow (Claude Pro/Max). */

import type { AuthInteraction, OAuthAuth, OAuthCredential } from "../types.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function postJson(url: string, body: Record<string, string | number>): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}

	return responseBody;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		});
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	let tokenData: { access_token: string; refresh_token: string; expires_in: number };
	try {
		tokenData = JSON.parse(responseBody) as { access_token: string; refresh_token: string; expires_in: number };
	} catch (error) {
		throw new Error(
			`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		type: "oauth",
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Complete Anthropic OAuth through its hosted authorization-code callback without opening a localhost listener.
 */
async function loginAnthropic(interaction: AuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});
	interaction.notify({
		type: "auth_url",
		url: `${AUTHORIZE_URL}?${authParams.toString()}`,
		instructions: "Complete login in your browser, then paste the authorization code shown by Anthropic.",
	});

	const parsed = parseAuthorizationInput(
		await interaction.prompt({
			type: "manual_code",
			message: "Paste the Anthropic authorization code:",
			signal: interaction.signal,
		}),
	);
	if (!parsed.code) throw new Error("Missing authorization code");
	if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");

	interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
	return exchangeAuthorizationCode(parsed.code, parsed.state ?? verifier, verifier, REDIRECT_URI);
}

/**
 * Refresh Anthropic OAuth token
 */
async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		});
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	let data: { access_token: string; refresh_token: string; expires_in: number; scope?: string };
	try {
		data = JSON.parse(responseBody) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
			scope?: string;
		};
	} catch (error) {
		throw new Error(
			`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		type: "oauth",
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic (Claude Pro/Max)",
	login: loginAnthropic,
	refresh: (credential) => refreshAnthropicToken(credential.refresh),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
