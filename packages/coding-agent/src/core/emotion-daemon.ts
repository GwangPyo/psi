/**
 * A long-lived background daemon that monitors session events.
 * It accumulates background context and triggers subagent analysis upon detecting strong negative reactions.
 */
export class BackgroundEmotionDaemon {
	private _runningContext: string = "";
	private _unsubscribe: (() => void) | null = null;

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
}
