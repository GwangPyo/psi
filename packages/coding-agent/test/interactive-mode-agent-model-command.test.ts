import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface DefaultAgentModelCommandContext {
	settingsManager: {
		getSubagentDefaultModel: () => string | undefined;
		setSubagentDefaultModel: (modelReference: string | undefined) => void;
		getBackgroundAgentDefaultModel: () => string | undefined;
		setBackgroundAgentDefaultModel: (modelReference: string | undefined) => void;
		flush: () => Promise<void>;
	};
	session: {
		modelRuntime: {
			getAvailable: () => Promise<readonly { provider: string; id: string }[]>;
		};
	};
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleDefaultAgentModelCommand(
		this: DefaultAgentModelCommandContext,
		text: string,
		role: "subagent" | "background-agent",
	): Promise<void>;
};

function createContext(selected?: string): DefaultAgentModelCommandContext {
	let subagentModel: string | undefined;
	let backgroundAgentModel: string | undefined;
	return {
		settingsManager: {
			getSubagentDefaultModel: () => subagentModel,
			setSubagentDefaultModel: (modelReference) => {
				subagentModel = modelReference;
			},
			getBackgroundAgentDefaultModel: () => backgroundAgentModel,
			setBackgroundAgentDefaultModel: (modelReference) => {
				backgroundAgentModel = modelReference;
			},
			flush: vi.fn(async () => {}),
		},
		session: {
			modelRuntime: {
				getAvailable: vi.fn(async () => [
					{ provider: "openai", id: "gpt-5" },
					{ provider: "anthropic", id: "claude-sonnet" },
				]),
			},
		},
		showExtensionSelector: vi.fn(async () => selected),
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
}

describe("built-in agent model commands", () => {
	it("registers both commands for slash autocomplete", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names).toContain("subagent-model");
		expect(names).toContain("background-agent-model");
	});

	it("stores a directly specified subagent model", async () => {
		const context = createContext();

		await interactiveModePrototype.handleDefaultAgentModelCommand.call(
			context,
			"/subagent-model openai/gpt-5",
			"subagent",
		);

		expect(context.settingsManager.getSubagentDefaultModel()).toBe("openai/gpt-5");
		expect(context.settingsManager.flush).toHaveBeenCalledOnce();
		expect(context.showStatus).toHaveBeenCalledWith("Subagent default model set to openai/gpt-5.");
	});

	it("stores a background-agent model selected from available models", async () => {
		const context = createContext("anthropic/claude-sonnet");

		await interactiveModePrototype.handleDefaultAgentModelCommand.call(
			context,
			"/background-agent-model",
			"background-agent",
		);

		expect(context.showExtensionSelector).toHaveBeenCalledWith("Background agent default model", [
			"Clear background-agent model override",
			"anthropic/claude-sonnet",
			"openai/gpt-5",
		]);
		expect(context.settingsManager.getBackgroundAgentDefaultModel()).toBe("anthropic/claude-sonnet");
		expect(context.settingsManager.flush).toHaveBeenCalledOnce();
	});
});
