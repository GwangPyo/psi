import { createAgentSession } from "./packages/coding-agent/src/core/sdk.ts";
import { resolve } from "path";

async function main() {
    const { session } = await createAgentSession({
        cwd: resolve("."),
        agentDir: resolve(".gemini"),
    });

    const runner = (session as any)._extensionRunnerRef?.current;
    if (runner) {
        console.log("All registered tools:", runner.getAllRegisteredTools().map(t => t.definition.name));
    }
    console.log("Registry keys:", Array.from((session as any)._toolRegistry.keys()));
    
    // Simulate /plan command
    const planExt = runner.extensions.find(e => e.path.includes("plan"));
    console.log("Plan extension found:", !!planExt);
}
main().catch(console.error);
