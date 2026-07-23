/**
 * Prompt Customizer Extension
 *
 * Demonstrates using systemPromptOptions to make informed, context-aware
 * modifications to the system prompt without re-discovering resources.
 *
 * This extension adds project context based on the skills currently loaded,
 * respecting whatever the user has configured. Tool catalogs and guidance are
 * managed by the runtime and should not be copied into a prompt override.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use the extension — it automatically adapts to your active tools and skills
 */

import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Adds skill context from the resources already loaded for this project.
 */
function addSkillContext(options: BuildSystemPromptOptions, basePrompt: string): string {
	if (!options.skills || options.skills.length === 0) return basePrompt;
	const skillNames = options.skills.map((skill) => skill.name).join(", ");

	return `${basePrompt}

## Loaded Skill Context

Project skills available: ${skillNames}
`;
}

/**
 * Merges extension instructions with user-provided append prompts.
 * This respects whatever the user configured via --append-system-prompt
 * flags or files, rather than duplicating that work.
 */
function mergeWithUserAppend(options: BuildSystemPromptOptions): string {
	const userAppend = options.appendSystemPrompt;
	const extensionSpecific = `
## Extension-Added Context

This prompt includes project context loaded dynamically.
If you have additional requirements, configure them via --append-system-prompt or project context files.
`;

	if (userAppend) {
		return `${userAppend}\n\n${extensionSpecific}`;
	}

	return extensionSpecific;
}

export default function promptCustomizer(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const { systemPrompt, systemPromptOptions } = event;

		const customPrompt = addSkillContext(systemPromptOptions, systemPrompt);
		const appendSection = mergeWithUserAppend(systemPromptOptions);

		return {
			systemPrompt: `${customPrompt}${appendSection}`,
		};
	});
}
