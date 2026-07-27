import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { PlanMachineDefinition, PlanRuntimeSnapshot, PlanState, PlanTransition } from "./fsm/schema.ts";

interface PlanGraphComponentOptions {
	expanded?: boolean;
	snapshot?: PlanRuntimeSnapshot;
}

function plainStateLabel(state: PlanState, maxWidth: number): string {
	const title = state.title === state.id ? state.id : `${state.id} · ${state.title}`;
	return `[${truncateToWidth(title, Math.max(1, maxWidth - 2), "…")}]`;
}

function stateMarker(state: PlanState, snapshot: PlanRuntimeSnapshot | undefined): string {
	if (snapshot?.activeStateIds.includes(state.id)) return "▶";
	if (snapshot?.completedStateIds.includes(state.id)) return "✓";
	if (state.kind === "final") return "◎";
	return "○";
}

export class PlanGraphComponent implements Component {
	private readonly machine: PlanMachineDefinition;
	private readonly theme: Theme;
	private readonly options: PlanGraphComponentOptions;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(machine: PlanMachineDefinition, theme: Theme, options: PlanGraphComponentOptions = {}) {
		this.machine = machine;
		this.theme = theme;
		this.options = options;
	}

	private renderState(stateId: string, width: number): string {
		const state = this.machine.states.find((candidate) => candidate.id === stateId);
		if (!state) return `[${truncateToWidth(stateId, Math.max(1, width - 2), "…")}]`;
		return `${stateMarker(state, this.options.snapshot)} ${plainStateLabel(state, Math.max(1, width - 2))}`;
	}

	private renderTransition(transition: PlanTransition, width: number): string[] {
		const lines: string[] = [];
		const branchWidth = Math.max(8, width - 6);

		if (transition.from.length === 1) {
			lines.push(this.theme.fg("accent", this.renderState(transition.from[0]!, width)));
		} else {
			lines.push(this.theme.fg("muted", "ALL OF"));
			for (const [index, stateId] of transition.from.entries()) {
				const connector = index === transition.from.length - 1 ? "└─" : "├─";
				lines.push(
					this.theme.fg("borderMuted", connector) +
						" " +
						this.theme.fg("accent", this.renderState(stateId, branchWidth)),
				);
			}
		}

		lines.push(
			this.theme.fg("borderMuted", "│") +
				" " +
				this.theme.fg("warning", truncateToWidth(transition.event, Math.max(1, width - 2), "…")),
		);

		for (const [index, stateId] of transition.to.entries()) {
			const connector = index === transition.to.length - 1 ? "└─▶" : "├─▶";
			lines.push(
				this.theme.fg("borderMuted", connector) +
					" " +
					this.theme.fg("accent", this.renderState(stateId, branchWidth)),
			);
		}
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const renderWidth = Math.max(1, width);
		const lines: string[] = [
			truncateToWidth(
				this.theme.fg("success", this.theme.bold("PlanFSM accepted")) +
					this.theme.fg("dim", ` · ${this.machine.parallelism.strategy}`),
				renderWidth,
				"…",
			),
		];
		for (const goalLine of wrapTextWithAnsi(this.theme.fg("text", this.machine.goal), renderWidth)) {
			lines.push(truncateToWidth(goalLine, renderWidth, "…"));
		}
		lines.push("");
		lines.push(
			this.theme.fg("borderMuted", "◆ START") +
				" " +
				this.theme.fg("borderMuted", "─▶") +
				" " +
				this.theme.fg("accent", this.renderState(this.machine.initialStateId, Math.max(8, renderWidth - 11))),
		);

		for (const transition of this.machine.transitions) {
			lines.push("");
			lines.push(...this.renderTransition(transition, renderWidth));
		}

		for (const state of this.machine.states.filter((candidate) => candidate.kind === "final")) {
			lines.push("");
			lines.push(
				this.theme.fg("accent", this.renderState(state.id, Math.max(8, renderWidth - 8))) +
					" " +
					this.theme.fg("borderMuted", "─▶ ◆ END"),
			);
		}

		if (this.options.expanded) {
			lines.push("", this.theme.fg("muted", "State contracts"));
			for (const state of this.machine.states) {
				const metadata = `${state.kind} · ${state.abstraction} · ${state.role}`;
				lines.push(
					truncateToWidth(
						`${this.theme.fg("accent", `[${state.id}]`)} ${this.theme.fg("text", state.title)} ${this.theme.fg("dim", metadata)}`,
						renderWidth,
						"…",
					),
				);
				for (const criterion of state.acceptanceCriteria) {
					for (const criterionLine of wrapTextWithAnsi(
						`${this.theme.fg("borderMuted", "  └")} ${this.theme.fg("dim", criterion)}`,
						Math.max(1, renderWidth),
					)) {
						lines.push(truncateToWidth(criterionLine, renderWidth, "…"));
					}
				}
			}
		}

		lines.push(
			"",
			this.theme.fg(
				"dim",
				`${this.machine.states.length} states · ${this.machine.transitions.length} transitions${
					this.options.expanded ? "" : " · expand for state contracts"
				}`,
			),
		);

		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => truncateToWidth(line, renderWidth, "…"));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
