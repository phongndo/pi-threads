import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThreadExit } from "./domain.ts";

export const STOP_KILL_WAIT_MS = 300;

/** Minimal process handle needed to signal/kill a live child. */
export type KillableThreadProcess = {
	readonly pid: number;
	readonly processGroupId: number | null;
	readonly child: ChildProcessWithoutNullStreams;
};

export function classifyProcessExit(input: {
	readonly code: number | null;
	readonly signal: string | null;
	readonly stopped: boolean;
}): ThreadExit {
	if (input.stopped) return { kind: "stopped", code: input.code, signal: input.signal };
	if (input.code === 0 && input.signal === null) {
		return { kind: "exited", code: input.code, signal: input.signal };
	}

	const details = [
		input.code === null ? null : `code ${input.code}`,
		input.signal === null ? null : `signal ${input.signal}`,
	]
		.filter((part): part is string => part !== null)
		.join(", ");
	return { kind: "failed", message: `Child Pi process exited with ${details || "unknown status"}` };
}

export function shouldLaunchDetachedProcessGroup(): boolean {
	return process.platform !== "win32";
}

export async function signalThreadProcessTree(
	thread: KillableThreadProcess,
	signal: NodeJS.Signals,
): Promise<void> {
	if (process.platform === "win32") {
		if (signal === "SIGKILL") {
			if (await taskkillWindowsProcessTree(thread.pid)) return;
		}

		safeKillChild(thread, signal);
		return;
	}

	if (thread.processGroupId !== null) {
		try {
			process.kill(-thread.processGroupId, signal);
			return;
		} catch {
			// Fall back to the direct child process. Process groups can already be gone
			// or unavailable under tests/sandboxes; stopping must remain best-effort.
		}
	}

	safeKillChild(thread, signal);
}

function taskkillWindowsProcessTree(pid: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(ok);
		};
		const timeout = setTimeout(() => finish(false), STOP_KILL_WAIT_MS);
		timeout.unref?.();

		try {
			const taskkill = execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], (error) => {
				finish(error === null);
			});
			taskkill.on?.("error", () => finish(false));
		} catch {
			finish(false);
		}
	});
}

export function safeKillChild(thread: KillableThreadProcess, signal: NodeJS.Signals): void {
	try {
		thread.child.kill(signal);
	} catch {
		// Process cleanup is best-effort; lifecycle code synthesizes a final stopped
		// snapshot if no close event arrives after the bounded wait.
	}
}

export function getPiInvocation(args: readonly string[]): {
	readonly command: string;
	readonly args: readonly string[];
} {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/u.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}
