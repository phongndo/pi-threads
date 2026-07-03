import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asThreadId, asThreadPath } from "../src/domain.ts";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return { ...actual, spawn: spawnMock };
});

const { ThreadManager } = await import("../src/thread-manager.ts");

class FakeChildProcess extends EventEmitter {
	readonly pid = 12_345;
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly kill = vi.fn((signal?: NodeJS.Signals) => {
		queueMicrotask(() => this.emit("close", null, signal ?? null));
		return true;
	});
}

function context(): ExtensionContext {
	return {
		cwd: "/tmp/project",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;
}

function respond(child: FakeChildProcess, request: Record<string, unknown>, data?: unknown): void {
	child.stdout.write(
		`${JSON.stringify({
			type: "response",
			id: request["id"],
			command: request["type"],
			success: true,
			...(data === undefined ? {} : { data }),
		})}\n`,
	);
}

function attachRpc(child: FakeChildProcess, onRequest: (request: Record<string, unknown>) => void) {
	let buffer = "";
	child.stdin.on("data", (chunk: Buffer | string) => {
		buffer += String(chunk);
		for (;;) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			onRequest(JSON.parse(line) as Record<string, unknown>);
		}
	});
}

describe("ThreadManager session metadata", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("records a child session before a fast-finishing child closes", async () => {
		const child = new FakeChildProcess();
		const requests: string[] = [];
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			requests.push(String(request["type"]));
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/quick.jsonl",
					sessionId: "session-quick",
					sessionName: "Quick child",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") {
				respond(child, request);
				queueMicrotask(() => child.emit("close", 0, null));
			}
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start({ action: "start", prompt: "finish", taskName: "quick" }, context());
		await new Promise<void>((resolve) => setImmediate(resolve));

		const snapshot = manager.list({ action: "list", state: "all" })[0];
		expect(requests.slice(0, 2)).toEqual(["get_state", "prompt"]);
		expect(snapshot?.state).toBe("closed");
		expect(snapshot?.session).toEqual({
			kind: "known",
			file: "/tmp/quick.jsonl",
			id: "session-quick",
			name: "Quick child",
			pendingMessageCount: 0,
		});
	});

	it("uses the rebound thread scope when starting nested work after a session switch", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/nested.jsonl",
					sessionId: "session-nested",
					sessionName: "Nested child",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "3",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);
		manager.rebindScope({
			currentPath: asThreadPath("/root/alpha"),
			depth: 1,
			selfThreadId: asThreadId("thread_aaaaaaaaaaaa"),
		});

		const outcome = await manager.start(
			{ action: "start", prompt: "nested", taskName: "beta" },
			context(),
		);

		expect(outcome.thread.path).toBe("/root/alpha/beta");
		expect(outcome.thread.parentPath).toBe("/root/alpha");
		expect(outcome.thread.depth).toBe(2);
		expect(spawnMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					PI_THREADS_DEPTH: "2",
					PI_THREADS_PARENT_ID: "thread_aaaaaaaaaaaa",
					PI_THREADS_PARENT_PATH: "/root/alpha",
					PI_THREADS_PATH: "/root/alpha/beta",
				}),
			}),
		);
	});
});
