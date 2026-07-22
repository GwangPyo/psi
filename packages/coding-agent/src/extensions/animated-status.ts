const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_SPINNER_INTERVAL_MS = 80;

export interface AnimatedStatus {
	setLabel(label: string): void;
	stop(): void;
}

export function startAnimatedStatus(options: {
	label: string;
	setStatus(text: string | undefined): void;
	render(frame: string, label: string): string;
}): AnimatedStatus {
	let frameIndex = 0;
	let label = options.label;
	let stopped = false;

	const render = () => {
		if (stopped) return;
		const frame = STATUS_SPINNER_FRAMES[frameIndex % STATUS_SPINNER_FRAMES.length] ?? "";
		options.setStatus(options.render(frame, label));
	};

	render();
	const timer = setInterval(() => {
		frameIndex = (frameIndex + 1) % STATUS_SPINNER_FRAMES.length;
		render();
	}, STATUS_SPINNER_INTERVAL_MS);
	timer.unref();

	return {
		setLabel(nextLabel) {
			label = nextLabel;
			render();
		},
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			options.setStatus(undefined);
		},
	};
}
