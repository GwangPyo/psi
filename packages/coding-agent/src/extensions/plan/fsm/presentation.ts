import type { PlanMachineDefinition, PlanRuntimeSnapshot, PlanState, PlanTransition } from "./schema.ts";
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function stateLabel(state: PlanState): string {
	return `${state.id}: ${state.title} [${state.kind} · ${state.abstraction} · ${state.role}]`;
}

function transitionLabel(transition: PlanTransition): string {
	return `${transition.id}: ${transition.from.join(" + ")} --${transition.event}--> ${transition.to.join(" + ")}`;
}

export function formatPlanMachine(machine: PlanMachineDefinition): string {
	const lines = [
		`Goal: ${machine.goal}`,
		`Scheduling: ${machine.parallelism.strategy} — ${machine.parallelism.rationale}`,
		"",
		"```mermaid",
		"stateDiagram-v2",
	];

	for (const state of machine.states) {
		const safeTitle = state.title.replace(/[:"\\[\]]/g, "");
		lines.push(`    ${state.id} : ${safeTitle}`);
	}

	lines.push(`    [*] --> ${machine.initialStateId}`);

	for (const transition of machine.transitions) {
		if (transition.from.length === 1 && transition.to.length === 1) {
			lines.push(`    ${transition.from[0]} --> ${transition.to[0]} : ${transition.event}`);
		} else {
			const syncNode = `sync_${transition.id}`;
			const isFork = transition.from.length === 1 && transition.to.length > 1;
			const isJoin = transition.from.length > 1 && transition.to.length === 1;

			if (isFork) {
				lines.push(`    state ${syncNode} <<fork>>`);
				lines.push(`    ${transition.from[0]} --> ${syncNode} : ${transition.event}`);
				for (const t of transition.to) lines.push(`    ${syncNode} --> ${t}`);
			} else if (isJoin) {
				lines.push(`    state ${syncNode} <<join>>`);
				for (const f of transition.from) lines.push(`    ${f} --> ${syncNode}`);
				lines.push(`    ${syncNode} --> ${transition.to[0]} : ${transition.event}`);
			} else {
				lines.push(`    state ${syncNode} <<join>>`);
				for (const f of transition.from) lines.push(`    ${f} --> ${syncNode}`);
				for (const t of transition.to) lines.push(`    ${syncNode} --> ${t} : ${transition.event}`);
			}
		}
	}

	for (const state of machine.states) {
		if (state.kind === "final") {
			lines.push(`    ${state.id} --> [*]`);
		}
	}

	lines.push("```");
	return lines.join("\n");
}

export function formatPlanRuntime(machine: PlanMachineDefinition, snapshot: PlanRuntimeSnapshot): string {
	const stateById = new Map(machine.states.map((state) => [state.id, state]));
	const active = snapshot.activeStateIds
		.map((stateId) => stateById.get(stateId))
		.filter((state) => state !== undefined);
	const lines = [
		`Plan status: ${snapshot.status}`,
		`Goal: ${machine.goal}`,
		`Active states: ${active.length > 0 ? active.map((state) => stateLabel(state)).join(", ") : "none"}`,
		`Transitions applied: ${snapshot.transitionCount}/${machine.limits.maxTransitions}`,
	];
	if (snapshot.blockReason) lines.push(`Block reason: ${snapshot.blockReason}`);
	return lines.join("\n");
}

export function formatPlanWidget(machine: PlanMachineDefinition, snapshot: PlanRuntimeSnapshot): string[] {
	const active = new Set(snapshot.activeStateIds);
	const completed = new Set(snapshot.completedStateIds);
	return machine.states.map((state) => {
		const marker = active.has(state.id) ? "▶" : completed.has(state.id) ? "✓" : "○";
		return `${marker} ${state.title} (${state.role})`;
	});
}

export function formatActiveStateInstructions(machine: PlanMachineDefinition, snapshot: PlanRuntimeSnapshot): string {
	const stateById = new Map(machine.states.map((state) => [state.id, state]));
	return snapshot.activeStateIds
		.map((stateId) => stateById.get(stateId))
		.filter((state) => state !== undefined)
		.map((state) => {
			const lines = [stateLabel(state)];
			if (state.instruction) lines.push(`  Instruction: ${state.instruction}`);
			if (state.acceptanceCriteria.length > 0) {
				lines.push(`  Acceptance: ${state.acceptanceCriteria.join("; ")}`);
			}
			if (state.errorPolicy) {
				lines.push(
					`  Error policy: ${state.errorPolicy.strategy}; mayHideFailure=${state.errorPolicy.mayHideFailure}; suppressionAllowed=${state.errorPolicy.suppressionAllowed}`,
				);
			}
			return lines.join("\n");
		})
		.join("\n");
}

export function formatEnabledTransitions(transitions: PlanTransition[]): string {
	if (transitions.length === 0) return "none";
	return transitions.map((transition) => `- ${transitionLabel(transition)}`).join("\n");
}

export async function popupPlanGraph(machine: PlanMachineDefinition): Promise<void> {
	try {
		const lines = ["stateDiagram-v2"];
		for (const state of machine.states) {
			const safeTitle = state.title.replace(/[:"\\[\]]/g, "");
			lines.push(`    ${state.id} : ${safeTitle}`);
		}
		lines.push(`    [*] --> ${machine.initialStateId}`);
		for (const transition of machine.transitions) {
			if (transition.from.length === 1 && transition.to.length === 1) {
				lines.push(`    ${transition.from[0]} --> ${transition.to[0]} : ${transition.event}`);
			} else {
				const syncNode = `sync_${transition.id}`;
				const isFork = transition.from.length === 1 && transition.to.length > 1;
				const isJoin = transition.from.length > 1 && transition.to.length === 1;

				if (isFork) {
					lines.push(`    state ${syncNode} <<fork>>`);
					lines.push(`    ${transition.from[0]} --> ${syncNode} : ${transition.event}`);
					for (const t of transition.to) lines.push(`    ${syncNode} --> ${t}`);
				} else if (isJoin) {
					lines.push(`    state ${syncNode} <<join>>`);
					for (const f of transition.from) lines.push(`    ${f} --> ${syncNode}`);
					lines.push(`    ${syncNode} --> ${transition.to[0]} : ${transition.event}`);
				} else {
					lines.push(`    state ${syncNode} <<join>>`);
					for (const f of transition.from) lines.push(`    ${f} --> ${syncNode}`);
					for (const t of transition.to) lines.push(`    ${syncNode} --> ${t} : ${transition.event}`);
				}
			}
		}
		for (const state of machine.states) {
			if (state.kind === "final") {
				lines.push(`    ${state.id} --> [*]`);
			}
		}
		const html = `<!DOCTYPE html>
<html>
<head>
    <title>PlanFSM Graph</title>
    <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
      mermaid.initialize({ startOnLoad: true, theme: 'dark' });
    </script>
    <style>
      body { background-color: #1a1a1a; color: white; display: flex; justify-content: center; padding: 2rem; }
    </style>
</head>
<body>
    <div class="mermaid">
${lines.join("\n")}
    </div>
</body>
</html>`;
		const tempFile = path.join(os.tmpdir(), `plan-graph-${Date.now()}.html`);
		await fs.writeFile(tempFile, html);
		exec(`wslview "${tempFile}"`, (err) => {
			if (err) {
				exec(`xdg-open "${tempFile}"`, (err2) => {
					if (err2) exec(`open "${tempFile}"`);
				});
			}
		});
	} catch (e) {
		// Ignore popup errors
	}
}
