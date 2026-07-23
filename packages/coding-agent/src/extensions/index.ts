import type { InlineExtension } from "../core/extensions/types.ts";
import adversarialConversationExtension from "./adversarial-conversation/index.ts";
import extensionManagerExtension from "./extension-manager/index.ts";
import llamaExtension from "./llama/index.ts";
import planExtension from "./plan/index.ts";
import projectGraphExtension from "./project-graph/index.ts";
import researchExtension from "./research/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "plan", factory: planExtension },
	adversarialConversationExtension,
	{ name: "research", factory: researchExtension },
	{ name: "project-graph", factory: projectGraphExtension, hidden: true },
	{ name: "extension-manager", factory: extensionManagerExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
