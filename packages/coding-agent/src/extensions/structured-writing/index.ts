import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

export interface SWFunction {
	name: string;
	flag: "hard" | "easy";
	status: "spec_written" | "delegated" | "pending_review" | "accepted" | "rejected" | "implemented";
	subagentCode?: string;
}

export interface SWSubgoal {
	description: string;
	functions: Record<string, SWFunction>;
	status: "spec_phase" | "impl_phase" | "done";
}

export class StructuredWritingManager {
	public enabled = false;
	public currentSubgoal: SWSubgoal | undefined;
	public completedSubgoals: SWSubgoal[] = [];

	enable() {
		this.enabled = true;
	}
	disable() {
		this.enabled = false;
		this.currentSubgoal = undefined;
		this.completedSubgoals = [];
	}

	getStateSummary(): string {
		if (!this.enabled) return "Structured Writing Mode is OFF.";
		let summary = "=== Structured Writing State ===\n";
		if (!this.currentSubgoal) {
			summary += "No active subgoal. You must declare a subgoal using `sw_declare_subgoal`.\n";
		} else {
			summary += `Active Subgoal: ${this.currentSubgoal.description}\n`;
			summary += `Phase: ${this.currentSubgoal.status}\n\n`;
			const funcs = Object.values(this.currentSubgoal.functions);
			if (funcs.length === 0) {
				summary += "No functions registered yet. Write specs and use `sw_register_specs`.\n";
			} else {
				summary += "Functions:\n";
				for (const f of funcs) {
					summary += `- ${f.name} [${f.flag.toUpperCase()}] : ${f.status}\n`;
				}
			}
		}
		return summary;
	}
}

export const swManager = new StructuredWritingManager();

export default function structuredWritingExtension(pi: ExtensionAPI): void {
	pi.registerCommand("structured_writing", {
		description: "Toggle Structured Writing Mode (subgoal spec first, delegate [easy] tasks to subagent)",
		handler: async (_args, ctx) => {
			swManager.enabled = !swManager.enabled;
			if (!swManager.enabled) swManager.disable();
			ctx.ui.notify(
				`Structured Writing mode is now ${swManager.enabled ? "ON" : "OFF"}.`,
				swManager.enabled ? "info" : "info",
			);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (swManager.enabled) {
			const prompt = `[STRUCTURED WRITING MODE ACTIVE]\nYou MUST follow this structured writing workflow for all implementation tasks:\n1. Establish Subgoals: Declare subgoals using \`sw_declare_subgoal\`.\n2. Specification First: Write ONLY the class or function specifications (signatures, types, docstrings) using edit/write tools.\n3. Register Specs: Call \`sw_register_specs\` to register the specs with a flag: [hard] or [easy].\n4. Implementation:\n   - Delegate [easy] functions to a subagent using \`sw_delegate_easy\`.\n   - Implement [hard] functions yourself, then call \`sw_mark_implemented\`.\n5. Review: Review subagent code with \`sw_review\`. If rejected, you must implement it yourself.\n6. Finish: Call \`sw_finish_subgoal\` when all functions are accepted or implemented.\n\nCurrent state:\n${swManager.getStateSummary()}`;
			return {
				systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
			};
		}
	});

	pi.registerTool({
		name: "sw_declare_subgoal",
		label: "Declare Subgoal",
		description: "[Structured Writing] Start a new subgoal.",
		parameters: Type.Object({
			description: Type.String({ description: "Description of the subgoal." }),
		}),
		execute: async (_id, params, _sig, _update, _ctx) => {
			if (!swManager.enabled) throw new Error("Structured Writing mode is not enabled.");
			if (swManager.currentSubgoal && swManager.currentSubgoal.status !== "done") {
				throw new Error(`Current subgoal is not done: ${swManager.currentSubgoal.description}`);
			}
			swManager.currentSubgoal = {
				description: params.description,
				functions: {},
				status: "spec_phase",
			};
			return {
				content: [
					{
						type: "text",
						text: `Subgoal declared: ${params.description}\nNow, write the specifications (types, signatures, docstrings) for this subgoal using your edit/write tools, then call \`sw_register_specs\`.\n\n${swManager.getStateSummary()}`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "sw_register_specs",
		label: "Register Specs",
		description: "[Structured Writing] Register the functions you have written specs for.",
		parameters: Type.Object({
			functions: Type.Array(
				Type.Object({
					name: Type.String(),
					flag: Type.Union([Type.Literal("hard"), Type.Literal("easy")]),
				}),
			),
		}),
		execute: async (_id, params, _sig, _update, _ctx) => {
			if (!swManager.enabled || !swManager.currentSubgoal) throw new Error("No active subgoal.");
			if (swManager.currentSubgoal.status !== "spec_phase") throw new Error("Not in spec_phase.");

			for (const f of params.functions) {
				swManager.currentSubgoal.functions[f.name] = {
					name: f.name,
					flag: f.flag,
					status: "spec_written",
				};
			}
			swManager.currentSubgoal.status = "impl_phase";

			return {
				content: [
					{
						type: "text",
						text: `Registered ${params.functions.length} functions.\nTransitioned to impl_phase.\nYou must now delegate [EASY] functions to subagents via \`sw_delegate_easy\`, and implement [HARD] functions yourself via \`sw_mark_implemented\` after editing them.\n\n${swManager.getStateSummary()}`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "sw_delegate_easy",
		label: "Delegate Easy Task",
		description: "[Structured Writing] Delegate an [EASY] function to a subagent.",
		executionMode: "parallel",
		parameters: Type.Object({
			functionName: Type.String(),
			taskDescription: Type.String(),
			fileContext: Type.String(),
		}),
		execute: async (_id, params, _sig, _update, ctx) => {
			if (!swManager.enabled || !swManager.currentSubgoal) throw new Error("No active subgoal.");
			const func = swManager.currentSubgoal.functions[params.functionName];
			if (!func) throw new Error(`Function ${params.functionName} not found in current subgoal.`);
			if (func.flag !== "easy") throw new Error(`Function ${params.functionName} is not flagged [EASY].`);
			if (func.status !== "spec_written")
				throw new Error(`Function ${params.functionName} cannot be delegated from status ${func.status}.`);

			func.status = "delegated";

			const subagentModelRef = SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted ? ctx.isProjectTrusted() : true,
			}).getSubagentDefaultModel();
			let subagentModel = ctx.model;
			if (subagentModelRef) {
				const [provider, id] = subagentModelRef.split("/");
				subagentModel = ctx.modelRegistry.find(provider, id) ?? ctx.model;
			}
			if (!subagentModel) throw new Error("No model available for the subagent.");

			ctx.ui.notify(`Subagent is implementing ${params.functionName}...`, "info");

			const subagent = pi.spawnAgent({
				model: subagentModel,
				systemPrompt: `${ctx.getSystemPrompt()}\n\nYou are a subordinate coding agent. Your task is to implement the function requested by the main agent. Return ONLY the implemented code.`,
				toolNames: ["read", "bash", "grep", "find", "ls"],
			});

			try {
				const prompt = `Context:\n${params.fileContext}\n\nTask:\n${params.taskDescription}\n\nPlease implement ${params.functionName}.`;
				const result = await subagent.prompt(prompt);
				func.status = "pending_review";
				func.subagentCode = result;
				return {
					content: [
						{
							type: "text",
							text: `Subagent implementation for ${params.functionName}:\n\n${result}\n\nReview this code and call \`sw_review\` to accept or reject it.\n\n${swManager.getStateSummary()}`,
						},
					],
					details: {},
				};
			} finally {
				subagent.dispose();
			}
		},
	});

	pi.registerTool({
		name: "sw_review",
		label: "Review Subagent Code",
		description: "[Structured Writing] Accept or reject the subagent's code.",
		parameters: Type.Object({
			functionName: Type.String(),
			decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
		}),
		execute: async (_id, params, _sig, _update, _ctx) => {
			if (!swManager.enabled || !swManager.currentSubgoal) throw new Error("No active subgoal.");
			const func = swManager.currentSubgoal.functions[params.functionName];
			if (!func) throw new Error(`Function ${params.functionName} not found.`);
			if (func.status !== "pending_review")
				throw new Error(`Function ${params.functionName} is not pending review.`);

			if (params.decision === "accept") {
				func.status = "accepted";
				return {
					content: [
						{
							type: "text",
							text: `Code ACCEPTED. Now integrate it into the file using your edit/write tools.\n\n${swManager.getStateSummary()}`,
						},
					],
					details: {},
				};
			} else {
				func.status = "rejected";
				return {
					content: [
						{
							type: "text",
							text: `Code REJECTED (One-strike out). You MUST now implement ${params.functionName} yourself, and then call \`sw_mark_implemented\`.\n\n${swManager.getStateSummary()}`,
						},
					],
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "sw_mark_implemented",
		label: "Mark Implemented",
		description: "[Structured Writing] Mark a [HARD] or [REJECTED] function as implemented by you.",
		parameters: Type.Object({
			functionName: Type.String(),
		}),
		execute: async (_id, params, _sig, _update, _ctx) => {
			if (!swManager.enabled || !swManager.currentSubgoal) throw new Error("No active subgoal.");
			const func = swManager.currentSubgoal.functions[params.functionName];
			if (!func) throw new Error(`Function ${params.functionName} not found.`);

			if (func.flag === "easy" && func.status !== "rejected") {
				throw new Error(
					`Function ${params.functionName} is [EASY] and has not been rejected. You must delegate it.`,
				);
			}

			func.status = "implemented";
			return {
				content: [
					{
						type: "text",
						text: `Function ${params.functionName} marked as implemented.\n\n${swManager.getStateSummary()}`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "sw_finish_subgoal",
		label: "Finish Subgoal",
		description: "[Structured Writing] Finish the current subgoal.",
		parameters: Type.Object({}),
		execute: async (_id, _params, _sig, _update, _ctx) => {
			if (!swManager.enabled || !swManager.currentSubgoal) throw new Error("No active subgoal.");

			const pending = Object.values(swManager.currentSubgoal.functions).filter(
				(f) => f.status !== "accepted" && f.status !== "implemented",
			);
			if (pending.length > 0) {
				const names = pending.map((p) => p.name).join(", ");
				throw new Error(`Cannot finish subgoal. Pending functions: ${names}`);
			}

			swManager.currentSubgoal.status = "done";
			swManager.completedSubgoals.push(swManager.currentSubgoal);
			swManager.currentSubgoal = undefined;

			return {
				content: [
					{
						type: "text",
						text: `Subgoal finished successfully! You can declare a new subgoal.\n\n${swManager.getStateSummary()}`,
					},
				],
				details: {},
			};
		},
	});
}
