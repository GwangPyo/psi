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

	/**
	 * Classify the user's reply against the preceding assistant result and record the
	 * verdict as background context. Callers must not let the result gate a turn: the
	 * classification is advisory and runs alongside the turn it describes.
	 */
	public async analyzeSentiment(userText: string): Promise<boolean> {
		const lastAssistant = this.session.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant" && ((m as any).stopReason !== "aborted" || (m as any).content.length > 0));

		if (!lastAssistant) return false;
		const lastAssistantText = contentText((lastAssistant as any).content, "\n").trim();
		if (!lastAssistantText) return false;

		const negative = await this.analyzeEmotionInBackground(userText, lastAssistantText);
		this.backgroundRunningContext = negative
			? "Negative sentiment detected in the latest user reply."
			: "No negative sentiment detected in the latest user reply.";
		return negative;
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
			return await classifyNegativeSentiment(
				(context, toolChoice) =>
					this.modelRuntime.complete(bgModel, context, {
						apiKey: authResult.apiKey,
						headers: authResult.headers,
						env: authResult.env,
						toolChoice,
					}),
				bgModel.api,
				lastAssistantText,
				userText,
			);
		} catch (e: any) {
			// Never write to stdout/stderr: this runs behind the TUI and would corrupt the display.
			try {
				appendFileSync(
					".pi/emotion-analysis-error.log",
					`\n[${new Date().toISOString()}] Emotion Analysis Error:\n${e.stack || e}\n`,
				);
			} catch {
				// The project has no .pi directory, or the log is unwritable. The classification is advisory.
			}
			return false;
		}
	}
}
