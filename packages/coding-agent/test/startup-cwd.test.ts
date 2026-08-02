import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveStartupCwd } from "../src/main.ts";

it("recovers when the invoking shell's working directory was deleted", async () => {
	const originalCwd = process.cwd();
	const originalPwd = process.env.PWD;
	const root = await mkdtemp(join(process.env.PI_TEST_SCRATCH ?? tmpdir(), "pi-startup-cwd-"));
	const deletedCwd = join(root, "deleted");
	const recoveredCwd = join(root, "recovered");
	await Promise.all([mkdir(deletedCwd), mkdir(recoveredCwd)]);

	try {
		process.chdir(deletedCwd);
		process.env.PWD = recoveredCwd;
		await rm(deletedCwd, { recursive: true });

		expect(() => process.cwd()).toThrow(/ENOENT/u);
		expect(resolveStartupCwd()).toBe(recoveredCwd);
		expect(process.env.PWD).toBe(recoveredCwd);
	} finally {
		process.chdir(originalCwd);
		if (originalPwd === undefined) delete process.env.PWD;
		else process.env.PWD = originalPwd;
		await rm(root, { recursive: true, force: true });
	}
});
