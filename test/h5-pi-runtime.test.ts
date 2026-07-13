/**
 * H5 verification: Pi runtime behaviors that affect orphan cleanup and registry restore.
 *
 * These tests exercise real SessionManager / process semantics (no model/network).
 * Findings are summarized in plan.md under H5.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PI_THREAD_REGISTRY_ENTRY_TYPE } from "../src/thread-registry.ts";

const PI_CLI = fileURLToPath(
	new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);
const posixIt = process.platform === "win32" ? it.skip : it;

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function flushSessionWithAssistant(cwd: string, sessionDir: string): SessionManager {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({
		role: "user",
		content: "seed",
		timestamp: Date.now(),
	});
	manager.appendMessage(assistantMessage("seeded"));
	const sessionFile = manager.getSessionFile();
	if (sessionFile === undefined || !fs.existsSync(sessionFile)) {
		throw new Error("expected SessionManager to flush a session file after an assistant message");
	}
	return manager;
}

function customRegistryIds(entries: readonly { type: string; id: string; customType?: string }[]) {
	return entries
		.filter(
			(entry) => entry.type === "custom" && entry.customType === PI_THREAD_REGISTRY_ENTRY_TYPE,
		)
		.map((entry) => entry.id);
}

function waitForExit(
	child: ReturnType<typeof spawn>,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`timed out waiting for process exit after ${timeoutMs}ms`));
		}, timeoutMs);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

describe("H5 SessionManager dual-writer registry visibility", () => {
	it("makes concurrent open()+appendCustomEntry writers invisible to each other's getBranch()", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-h5-dual-"));
		try {
			const sessionDir = path.join(root, "sessions");
			const writerA = flushSessionWithAssistant(root, sessionDir);
			const sessionFile = writerA.getSessionFile();
			if (sessionFile === undefined) throw new Error("expected session file");

			const writerB = SessionManager.open(sessionFile, sessionDir);
			expect(writerB.getLeafId()).toBe(writerA.getLeafId());

			const idB = writerB.appendCustomEntry(PI_THREAD_REGISTRY_ENTRY_TYPE, {
				writer: "B",
			});
			const idA = writerA.appendCustomEntry(PI_THREAD_REGISTRY_ENTRY_TYPE, {
				writer: "A",
			});

			// Each live manager only knows about its own append; the other is a sibling side branch.
			expect(customRegistryIds(writerA.getBranch())).toEqual([idA]);
			expect(customRegistryIds(writerB.getBranch())).toEqual([idB]);
			expect(customRegistryIds(writerA.getEntries())).toEqual([idA]);
			expect(customRegistryIds(writerB.getEntries())).toEqual([idB]);

			// Fresh open indexes the full file, but getBranch() still walks only the leaf path.
			// leafId is the last entry in file order, so only the later append is on the branch.
			const fresh = SessionManager.open(sessionFile, sessionDir);
			const branchIds = customRegistryIds(fresh.getBranch());
			const allIds = customRegistryIds(fresh.getEntries());
			expect(allIds).toEqual(expect.arrayContaining([idA, idB]));
			expect(allIds).toHaveLength(2);
			expect(branchIds).toHaveLength(1);
			expect(branchIds[0]).toBe(idA); // A appended after B, so A is last/leaf
			expect(branchIds).not.toContain(idB);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("hides a cross-open appendCustomEntry behind a later live-session append on getBranch()", () => {
		// Mirrors pi-dispatch cross-session persistence:
		// SessionManager.open(target.sessionFile).appendCustomEntry(...) while the live
		// SessionManager continues appending on its own leaf pointer.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-h5-cross-"));
		try {
			const sessionDir = path.join(root, "sessions");
			const live = flushSessionWithAssistant(root, sessionDir);
			const sessionFile = live.getSessionFile();
			if (sessionFile === undefined) throw new Error("expected session file");

			const crossId = SessionManager.open(sessionFile, sessionDir).appendCustomEntry(
				PI_THREAD_REGISTRY_ENTRY_TYPE,
				{ writer: "cross" },
			);
			const liveId = live.appendCustomEntry(PI_THREAD_REGISTRY_ENTRY_TYPE, {
				writer: "live",
			});

			const fresh = SessionManager.open(sessionFile, sessionDir);
			const branchIds = customRegistryIds(fresh.getBranch());
			const allIds = customRegistryIds(fresh.getEntries());

			expect(allIds).toEqual([crossId, liveId]);
			expect(branchIds).toEqual([liveId]);
			expect(branchIds).not.toContain(crossId);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("H5 Pi RPC orphan / stdin EOF", () => {
	it("exits the real Pi RPC process when parent closes stdin (EOF)", async () => {
		const child = spawn(process.execPath, [PI_CLI, "--mode", "rpc"], {
			stdio: ["pipe", "ignore", "ignore"],
			env: process.env,
		});
		// Closing stdin should trigger rpc-mode's process.stdin "end" → shutdown().
		child.stdin?.end();
		const exit = await waitForExit(child, 20_000);
		expect(exit.signal).toBeNull();
		expect(exit.code).toBe(0);
	}, 25_000);

	posixIt(
		"exits a Pi RPC child after the parent is SIGKILL'd (pipe EOF)",
		async () => {
			const statusPath = path.join(
				fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-h5-sigkill-")),
				"status.json",
			);
			const parentScript = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ${JSON.stringify([PI_CLI, "--mode", "rpc"])}, {
  stdio: ["pipe", "ignore", "ignore"],
  env: process.env,
  detached: true,
});
writeFileSync(${JSON.stringify(statusPath)}, JSON.stringify({ childPid: child.pid }));
// Keep parent alive with open stdin pipe until SIGKILL.
setInterval(() => {}, 60_000);
`;
			const parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript], {
				stdio: ["ignore", "ignore", "ignore"],
			});

			let childPid: number | undefined;
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (fs.existsSync(statusPath)) {
					const status = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
						childPid?: number;
					};
					if (typeof status.childPid === "number") {
						childPid = status.childPid;
						break;
					}
				}
				// eslint-disable-next-line no-await-in-loop -- polling a status file until the spawned parent reports its child pid.
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			if (childPid === undefined) {
				parent.kill("SIGKILL");
				throw new Error("parent never reported child pid");
			}

			// Give RPC mode a moment to attach stdin handlers.
			await new Promise((resolve) => setTimeout(resolve, 500));
			process.kill(parent.pid!, "SIGKILL");

			const childDeadline = Date.now() + 15_000;
			let childAlive = true;
			while (Date.now() < childDeadline) {
				try {
					process.kill(childPid, 0);
					// eslint-disable-next-line no-await-in-loop -- repeatedly probe for process exit until the deadline.
					await new Promise((resolve) => setTimeout(resolve, 100));
				} catch {
					childAlive = false;
					break;
				}
			}

			if (childAlive) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					// already gone
				}
			}
			try {
				fs.rmSync(path.dirname(statusPath), { recursive: true, force: true });
			} catch {
				// ignore
			}

			expect(childAlive).toBe(false);
		},
		25_000,
	);
});
