import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";

/**
 * A long-lived background daemon that monitors session events.
 * It accumulates background context and triggers subagent analysis upon detecting strong negative reactions.
 */
export class BackgroundEmotionDaemon {
	private _session: AgentSession;
	private _runningContext: string = "";
	private _unsubscribe: (() => void) | null = null;
	private _destroyed = false;
	private _isProcessing = false;

	constructor(session: AgentSession) {
		this._session = session;
	}

	/**
	 * Starts the daemon by subscribing to session events.
	 */
	start(): void {
		// [HARD] Subscribe to session events and handle them
	}

	/**
	 * Destroys the daemon, cleaning up listeners.
	 */
	destroy(): void {
		this._destroyed = true;
		if (this._unsubscribe !== null) {
			this._unsubscribe();
			this._unsubscribe = null;
		}
	}

	/**
	 * Returns the current background context accumulated by the daemon.
	 */
	get context(): string {
		return this._runningContext;
	}

	/**
	 * Handles incoming session events.
	 */
	private async _handleEvent(event: AgentSessionEvent): Promise<void> {
		// [HARD] Handle message_end for user messages, trigger emotion analysis
	}

	/**
	 * Analyzes the user's emotion in the background.
	 */
	private async _analyzeEmotion(userText: string, lastAssistantText: string): Promise<boolean> {
		// [HARD] Move the logic from AgentSession._analyzeEmotionInBackground here
		return false; // Stub
	}

	/**
	 * Spawns a subagent to analyze the intention when a negative emotion is detected.
	 */
	private async _runIntentionAnalysisSubagent(): Promise<void> {
		// [HARD] Move the logic from AgentSession._runIntentionAnalysisSubagent here
	}
}
