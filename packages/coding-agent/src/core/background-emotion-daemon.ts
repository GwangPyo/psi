import { AgentSession } from "./agent-session.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { contentText } from "@earendil-works/pi-ai";
import { readFileSync, appendFileSync } from "node:fs";

export class BackgroundEmotionDaemon {
	public backgroundRunningContext: string = "";
	public session: AgentSession;
	public settingsManager: SettingsManager;
	public modelRuntime: ModelRuntime;
	private _unsubscribe: () => void;

	constructor(session: AgentSession, settingsManager: SettingsManager, modelRuntime: ModelRuntime) {
		this.session = session;
		this.settingsManager = settingsManager;
		this.modelRuntime = modelRuntime;
		
		this._unsubscribe = this.session.subscribe((event: any) => {
			if (event.type === "user_message_added") {
				
				this.analyzeAndRunIntention(event.text).catch(e => console.error("Daemon error:", e));
			}
		});
	}

	public dispose() {
		this._unsubscribe();
	}

	public async analyzeAndRunIntention(userText: string) {
		const lastAssistant = this.session.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant" && ((m as any).stopReason !== "aborted" || (m as any).content.length > 0));

		if (!lastAssistant) return;
		const lastAssistantText = contentText((lastAssistant as any).content, "\n").trim();
		if (!lastAssistantText) return;

		const isNegative = await this.analyzeEmotionInBackground(userText, lastAssistantText);
		if (isNegative) {
			const subagentResult = await this.runIntentionAnalysisSubagent(this.session.messages);
			
			await this.session.sendCustomMessage({
				customType: "intention_analysis_result",
				content: [{ type: "text", text: `[Intention Analysis Result]\n${subagentResult}` }],
				display: true,
			}, { deliverAs: "immediate" });
		}
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
			let systemPrompt = readFileSync(new URL("./emotion-analysis-prompt.md", import.meta.url), "utf-8");
			systemPrompt = systemPrompt
				.replace("{{PREVIOUS_SUMMARY}}", this.backgroundRunningContext || "No previous summary.")
				.replace("{{ASSISTANT_RESULT}}", lastAssistantText)
				.replace("{{USER_REPLY}}", userText);

			const result = await this.modelRuntime.completeSimple(
				bgModel,
				{
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: "Please update the running summary according to the instructions." }], timestamp: Date.now() }],
				},
				{
					apiKey: authResult.apiKey,
					headers: authResult.headers,
					env: authResult.env,
				}
			);

			const analysis = (result.content.find((c: any) => c.type === "text") as any)?.text || "";
			console.log("[EmotionDaemon] analysis:", analysis);
			let isNegative = false;
			let summaryText = analysis;

			if (analysis.includes("<NEGATIVE_REACTION>")) {
				isNegative = true;
				summaryText = analysis.replace("<NEGATIVE_REACTION>", "").trim();
				appendFileSync(".pi/emotion-analysis.log", `\n[${new Date().toISOString()}] Emotion Analysis (Negative Detected):\n${summaryText}\n`);
			}

			if (summaryText.trim()) {
				this.backgroundRunningContext = summaryText.trim();
			}

			return isNegative;
		} catch (e: any) {
			console.error("Emotion analysis failed:", e);
			import("node:fs").then(fs => fs.appendFileSync(".pi/emotion-analysis-error.log", "\n[" + new Date().toISOString() + "] Emotion Analysis Error:\n" + (e.stack || e) + "\n"));
			return false;
		}
	}

	public async runIntentionAnalysisSubagent(messages: any[]): Promise<string> {
		await this.session.sendCustomMessage({
			customType: "intention_analysis",
			content: [{ type: "text", text: "Agent degradation detected: intention analysis starting..." }],
			display: true,
		}, { deliverAs: "immediate" });

		const subModelRef = this.settingsManager.getSubagentDefaultModel();
		if (!subModelRef) return "Intention analysis failed: No subagent model configured.";

		const [providerId, ...rest] = subModelRef.split("/");
		const subModel = this.modelRuntime.getModel(providerId, rest.join("/"));
		if (!subModel) return "Intention analysis failed: Model not found.";

		try {
			const authResult = await this.session.getSummarizationRequestAuth(subModel);
			const systemPrompt = readFileSync(new URL("./intention-analysis-prompt.md", import.meta.url), "utf-8");

			const historyText = messages.slice(-5).map(m => {
				const content = (m as any).content ? contentText((m as any).content, " ") : "";
				return `${m.role.toUpperCase()}: ${content}`;
			}).join("\n\n");

			const userPrompt = `Recent History:\n${historyText}\n\nAnalyze the user's true intention.`;

			const result = await this.modelRuntime.completeSimple(
				subModel,
				{
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
				},
				{
					apiKey: authResult.apiKey,
					headers: authResult.headers,
					env: authResult.env,
				}
			);

			const analysis = (result.content.find((c: any) => c.type === "text") as any)?.text || "";
			return analysis || "No specific intention could be determined.";
		} catch (e) {
			return `Intention analysis error: ${e instanceof Error ? e.message : String(e)}`;
		}
	}
}
