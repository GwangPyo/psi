import { describe, expect, it } from "vitest";
import examplePlanExtension from "../examples/extensions/plan-mode/index.ts";
import builtInPlanExtension from "../src/extensions/plan/index.ts";

describe("plan-mode example extension", () => {
	it("delegates to the built-in PlanFSM extension", () => {
		expect(examplePlanExtension).toBe(builtInPlanExtension);
	});
});
