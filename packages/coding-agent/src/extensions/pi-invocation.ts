import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface PiInvocation {
	command: string;
	args: string[];
}

export function getPiInvocation(args: readonly string[]): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executableName = basename(process.execPath).toLowerCase();
	if (!/^(?:node|bun)(?:\.exe)?$/.test(executableName)) {
		return { command: process.execPath, args: [...args] };
	}
	return { command: "pi", args: [...args] };
}
