import { afterEach, describe, expect, it, vi } from "vitest";
import { googleGeminiCliOAuth } from "../src/auth/oauth/google-gemini-cli.ts";

const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const REDIRECT_URI = "https://antigravity.google/oauth-callback";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

describe("Google Antigravity OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("uses the Antigravity OAuth client and hosted callback", async () => {
		vi.useFakeTimers();
		const now = new Date("2026-07-29T00:00:00Z");
		vi.setSystemTime(now);

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://oauth2.googleapis.com/token") {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
				expect(params.get("code")).toBe("4/authorization-code");
				expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
				expect(params.get("code_verifier")).not.toBe("");
				return jsonResponse({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				});
			}
			if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
				expect(init?.headers).toMatchObject({ Authorization: "Bearer access-token" });
				return jsonResponse({ cloudaicompanionProject: "antigravity-project" });
			}
			if (url === "https://www.googleapis.com/oauth2/v2/userinfo") {
				return jsonResponse({ email: "user@example.com" });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		let authorizationUrl: URL | undefined;
		const credential = await googleGeminiCliOAuth.login({
			prompt: async (prompt) => {
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				return "4%2Fauthorization-code";
			},
			notify: (event) => {
				if (event.type === "device_code") throw new Error("Device authorization must not be used");
				if (event.type === "auth_url") authorizationUrl = new URL(event.url);
			},
		});

		expect(authorizationUrl?.searchParams.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
		expect(authorizationUrl?.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(authorizationUrl?.searchParams.get("scope")?.split(" ")).toEqual(
			expect.arrayContaining([
				"https://www.googleapis.com/auth/cloud-platform",
				"https://www.googleapis.com/auth/cclog",
				"https://www.googleapis.com/auth/experimentsandconfigs",
			]),
		);
		expect(credential).toEqual({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: now.getTime() + 3600 * 1000 - 5 * 60 * 1000,
			projectId: "antigravity-project",
			accountId: "user@example.com",
		});
	});
});
