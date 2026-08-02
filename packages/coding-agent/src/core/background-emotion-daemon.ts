import { appendFileSync } from "node:fs";
import { contentText } from "@earendil-works/pi-ai";
import { classifyNegativeSentiment } from "../extensions/dspy-features/sentiment/index.ts";
import type { AgentSession } from "./agent-session.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SettingsManager } from "./settings-manager.ts";

export class BackgroundEmotionDaemon {
	public backgroundRunningContext: string = "";
	public session: AgentSession;
	public settingsManager: SettingsManager;
	public modelRuntime: ModelRuntime;

	constructor(session: AgentSession, settingsManager: SettingsManager, modelRuntime: ModelRuntime) {
		this.session = session;
		this.settingsManager = settingsManager;
		this.modelRuntime = modelRuntime;
	}

	public async analyzeAndRunIntention(userText: string): Promise<boolean> {
		const lastAssistant = this.session.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant" && ((m as any).stopReason !== "aborted" || (m as any).content.length > 0));

		if (!lastAssistant) return false;
		const lastAssistantText = contentText((lastAssistant as any).content, "\n").trim();
		if (!lastAssistantText) return false;

		return this.analyzeEmotionInBackground(userText, lastAssistantText);
	}

	public async analyzeEmotionInBackground(userText: string, lastAssistantText: string): Promise<boolean> {
		const bgModelRef = this.settingsManager.getBackgroundAgentDefaultModel();
		if (!bgModelRef) return false;

		const [providerId, ...rest] = bgModelRef.split("/");
		const modelId = rest.join("/");
		const bgModel = this.modelRuntime.getModel(providerId, modelId);
		if (!bgModel) return false;

		try {
			const authResult = await this.session.getSummarizationRequestAuth(bgModel);
			return classifyNegativeSentiment(
				{
					complete: async (prompt) => {
						const result = await this.modelRuntime.completeSimple(
							bgModel,
							{
								messages: [
									{
										role: "user",
										content: [{ type: "text", text: prompt }],
										timestamp: Date.now(),
									},
								],
							},
							{
								apiKey: authResult.apiKey,
								headers: authResult.headers,
								env: authResult.env,
							},
						);
						return contentText(result.content, "\n");
					},
				},
				lastAssistantText,
				userText,
			);
		} catch (e: any) {
			console.error("Emotion analysis failed:", e);
			appendFileSync(
				".pi/emotion-analysis-error.log",
				`\n[${new Date().toISOString()}] Emotion Analysis Error:\n${e.stack || e}\n`,
			);
			return false;
		}
	}
}
