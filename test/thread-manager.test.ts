import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

const { ThreadManager, shouldApproveChildCwd } = await import("../src/thread-manager.ts");

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

function context(
	options: { readonly cwd?: string; readonly trusted?: boolean } = {},
): ExtensionContext {
	return {
		cwd: options.cwd ?? "/tmp/project",
		isProjectTrusted: () => options.trusted ?? true,
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

function emitRpcEvent(child: FakeChildProcess, event: Record<string, unknown>): void {
	child.stdout.write(`${JSON.stringify(event)}\n`);
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

	it("emits one change notification for a successful poll refresh", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/alpha.jsonl",
					sessionId: "session-alpha",
					sessionName: "Alpha",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);
		await manager.start({ action: "start", prompt: "work", taskName: "alpha" }, context());

		const onChange = vi.fn();
		manager.onChange(onChange);

		await manager.poll("/root/alpha");

		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("forces no-approve for a child cwd outside the trusted parent cwd", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/outside.jsonl",
					sessionId: "session-outside",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "outside", taskName: "outside", cwd: "../outside" },
			context(),
		);

		const args = spawnMock.mock.calls[0]?.[1] as readonly string[];
		expect(args).toContain("--no-approve");
		expect(args).not.toContain("--approve");
	});

	it("resolves inherited relative resource paths against the process startup cwd", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/resources.jsonl",
					sessionId: "session-resources",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);
		const originalArgv = process.argv;
		const startupCwd = process.cwd();
		const activeSessionCwd = "/tmp/other-project";

		try {
			process.argv = [
				"/usr/bin/node",
				"/opt/pi/dist/cli.js",
				"-e",
				".",
				"--skill",
				"skills/review",
			];

			await manager.start(
				{ action: "start", prompt: "resources", taskName: "resources", cwd: "child" },
				context({ cwd: activeSessionCwd }),
			);
		} finally {
			process.argv = originalArgv;
		}

		const args = spawnMock.mock.calls[0]?.[1] as readonly string[];
		const extensionIndex = args.indexOf("--extension");
		const skillIndex = args.indexOf("--skill");
		expect(extensionIndex).toBeGreaterThanOrEqual(0);
		expect(args[extensionIndex + 1]).toBe(path.resolve(startupCwd));
		expect(skillIndex).toBeGreaterThanOrEqual(0);
		expect(args[skillIndex + 1]).toBe(path.resolve(startupCwd, "skills/review"));
		expect(spawnMock.mock.calls[0]?.[2]).toEqual(
			expect.objectContaining({ cwd: path.resolve(activeSessionCwd, "child") }),
		);
	});

	it("classifies non-zero natural child exits as failed", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/fails.jsonl",
					sessionId: "session-fails",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") {
				respond(child, request);
				queueMicrotask(() => child.emit("close", 1, null));
			}
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start({ action: "start", prompt: "fail", taskName: "fails" }, context());
		await new Promise<void>((resolve) => setImmediate(resolve));

		const snapshot = manager.list({ action: "list", state: "all" })[0];
		expect(snapshot?.state).toBe("closed");
		if (snapshot?.state !== "closed") return;
		expect(snapshot.exit).toEqual({
			kind: "failed",
			message: "Child Pi process exited with code 1",
		});
	});

	it("does not refresh state when wait has a zero timeout", async () => {
		const child = new FakeChildProcess();
		const requests: string[] = [];
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			requests.push(String(request["type"]));
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/wait.jsonl",
					sessionId: "session-wait",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start({ action: "start", prompt: "wait", taskName: "waits" }, context());
		const requestCount = requests.length;

		const outcome = await manager.wait({ action: "wait", id: "waits", timeoutMs: 0 });

		expect(outcome.timedOut).toBe(true);
		expect(requests).toHaveLength(requestCount);
	});

	it("reports wait progress while a thread remains busy", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/wait-progress.jsonl",
					sessionId: "session-wait-progress",
					pendingMessageCount: 0,
					isStreaming: true,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start({ action: "start", prompt: "wait", taskName: "wait_progress" }, context());
		const onProgress = vi.fn();

		const outcome = await manager.wait(
			{ action: "wait", id: "wait_progress", timeoutMs: 20 },
			{ onProgress },
		);

		expect(outcome.timedOut).toBe(true);
		expect(onProgress).toHaveBeenCalled();
		expect(onProgress.mock.calls.at(-1)?.[0]).toEqual(
			expect.objectContaining({
				thread: expect.objectContaining({ path: "/root/wait_progress", phase: "busy" }),
			}),
		);
	});

	it("cancels wait before refreshing child state when the signal is aborted", async () => {
		const child = new FakeChildProcess();
		const requests: string[] = [];
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			requests.push(String(request["type"]));
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/wait-cancel.jsonl",
					sessionId: "session-wait-cancel",
					pendingMessageCount: 0,
					isStreaming: true,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start({ action: "start", prompt: "wait", taskName: "wait_cancel" }, context());
		const requestCount = requests.length;
		const controller = new AbortController();
		controller.abort();

		await expect(
			manager.wait(
				{ action: "wait", id: "wait_cancel", timeoutMs: 20 },
				{ signal: controller.signal },
			),
		).rejects.toThrow("Thread wait aborted");
		expect(requests).toHaveLength(requestCount);
	});

	it("keeps accepted initial prompts busy until child activity is observed", async () => {
		const child = new FakeChildProcess();
		let promptAccepted = false;
		let postAcceptStateRefreshes = 0;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				if (promptAccepted) postAcceptStateRefreshes++;
				respond(child, request, {
					sessionFile: "/tmp/initial-accepted-race.jsonl",
					sessionId: "session-initial-accepted-race",
					pendingMessageCount: 0,
					isStreaming: false,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") {
				promptAccepted = true;
				respond(child, request);
			}
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "initial_accepted_race" },
			context(),
		);

		const earlyOutcome = await manager.wait({
			action: "wait",
			id: "initial_accepted_race",
			timeoutMs: 20,
		});

		expect(postAcceptStateRefreshes).toBeGreaterThan(0);
		expect(earlyOutcome.timedOut).toBe(true);
		if (earlyOutcome.thread.state !== "live") return;
		expect(earlyOutcome.thread.phase).toBe("busy");

		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		const finishedOutcome = await manager.wait({
			action: "wait",
			id: "initial_accepted_race",
			timeoutMs: 20,
		});

		expect(finishedOutcome.timedOut).toBe(false);
		if (finishedOutcome.thread.state !== "live") return;
		expect(finishedOutcome.thread.phase).toBe("idle");
	});

	it("keeps timed-out initial prompts non-idle until acceptance is known", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeChildProcess();
			const promptRequests: Record<string, unknown>[] = [];
			spawnMock.mockReturnValue(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile: "/tmp/slow-initial.jsonl",
						sessionId: "session-slow-initial",
						pendingMessageCount: 0,
						isStreaming: false,
						isCompacting: false,
					});
					return;
				}

				if (request["type"] === "prompt") {
					promptRequests.push(request);
					if (request["streamingBehavior"] === "followUp") respond(child, request);
				}
			});

			const manager = new ThreadManager({
				PI_THREADS_DEPTH: "0",
				PI_THREADS_MAX_DEPTH: "2",
				PI_THREADS_MAX_THREADS: "8",
				PI_THREADS_PATH: "/root",
				PI_THREADS_ROOT_SESSION_ID: "test-root",
			} as NodeJS.ProcessEnv);

			const startPromise = manager.start(
				{ action: "start", prompt: "initial", taskName: "slow_initial" },
				context(),
			);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(4_000);
			const startOutcome = await startPromise;

			expect(startOutcome.note).toMatch(/Timed out waiting for RPC response to prompt/u);
			if (startOutcome.thread.state !== "live") return;
			expect(startOutcome.thread.phase).toBe("starting");

			const pollOutcome = await manager.poll("slow_initial");
			if (pollOutcome.state !== "live") return;
			expect(pollOutcome.phase).toBe("starting");

			const sendOutcome = await manager.send({
				action: "send",
				id: "slow_initial",
				message: "queued after timeout",
			});

			expect(sendOutcome.accepted).toBe(true);
			expect(sendOutcome.mode).toBe("follow_up");
			expect(promptRequests).toHaveLength(2);
			expect(promptRequests[1]).toEqual(
				expect.objectContaining({
					type: "prompt",
					message: "queued after timeout",
					streamingBehavior: "followUp",
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refreshes idle live threads before reporting wait completion", async () => {
		const child = new FakeChildProcess();
		let promptCount = 0;
		let secondPromptAccepted = false;
		let waitStateRefreshes = 0;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				if (secondPromptAccepted) waitStateRefreshes++;
				respond(child, request, {
					sessionFile: "/tmp/wait-refresh.jsonl",
					sessionId: "session-wait-refresh",
					pendingMessageCount: 0,
					isStreaming: secondPromptAccepted,
				});
				return;
			}

			if (request["type"] === "prompt") {
				promptCount++;
				if (promptCount === 2) secondPromptAccepted = true;
				respond(child, request);
			}
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_refresh" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		await manager.send({ action: "send", id: "wait_refresh", message: "again" });
		const outcome = await manager.wait({ action: "wait", id: "wait_refresh", timeoutMs: 20 });

		expect(waitStateRefreshes).toBeGreaterThan(0);
		expect(outcome.timedOut).toBe(true);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("busy");
	});

	it("completes wait when an accepted idle send produces no agent activity", async () => {
		const child = new FakeChildProcess();
		let promptCount = 0;
		let secondPromptAccepted = false;
		let postSendStateRefreshes = 0;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				if (secondPromptAccepted) postSendStateRefreshes++;
				respond(child, request, {
					sessionFile: "/tmp/wait-send-awaiting.jsonl",
					sessionId: "session-wait-send-awaiting",
					pendingMessageCount: 0,
					isStreaming: false,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") {
				promptCount++;
				if (promptCount === 2) secondPromptAccepted = true;
				respond(child, request);
			}
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_send_awaiting" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		await manager.send({ action: "send", id: "wait_send_awaiting", message: "again" });
		const outcome = await manager.wait({
			action: "wait",
			id: "wait_send_awaiting",
			timeoutMs: 20,
		});

		expect(postSendStateRefreshes).toBeGreaterThan(0);
		expect(outcome.timedOut).toBe(false);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("idle");
	});

	it("completes wait after an accepted idle send observes activity and becomes idle", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/wait-send-finished.jsonl",
					sessionId: "session-wait-send-finished",
					pendingMessageCount: 0,
					isStreaming: false,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_send_finished" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		await manager.send({ action: "send", id: "wait_send_finished", message: "again" });
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		const outcome = await manager.wait({
			action: "wait",
			id: "wait_send_finished",
			timeoutMs: 20,
		});

		expect(outcome.timedOut).toBe(false);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("idle");
	});

	it("completes wait when a fast child finishes before send resumes", async () => {
		const child = new FakeChildProcess();
		let promptCount = 0;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/wait-send-fast.jsonl",
					sessionId: "session-wait-send-fast",
					pendingMessageCount: 0,
					isStreaming: false,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") {
				promptCount++;
				respond(child, request);
				if (promptCount === 2) {
					emitRpcEvent(child, { type: "agent_start" });
					emitRpcEvent(child, { type: "agent_end" });
				}
			}
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_send_fast" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		const sendOutcome = await manager.send({
			action: "send",
			id: "wait_send_fast",
			message: "again",
		});
		const outcome = await manager.wait({
			action: "wait",
			id: "wait_send_fast",
			timeoutMs: 20,
		});

		expect(sendOutcome.accepted).toBe(true);
		expect(outcome.timedOut).toBe(false);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("idle");
	});

	it.each([
		["follow_up", "followUp"],
		["steer", "steer"],
	] as const)(
		"sends explicit %s to an idle child as a starting prompt",
		async (mode, streamingBehavior) => {
			const child = new FakeChildProcess();
			const sendPrompts: Record<string, unknown>[] = [];
			let promptCount = 0;
			spawnMock.mockReturnValue(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile: `/tmp/idle-${mode}.jsonl`,
						sessionId: `session-idle-${mode}`,
						pendingMessageCount: 0,
						isStreaming: false,
						isCompacting: false,
					});
					return;
				}

				if (request["type"] === "prompt") {
					promptCount++;
					if (promptCount === 2) sendPrompts.push(request);
					respond(child, request);
					if (promptCount === 2) {
						emitRpcEvent(child, { type: "agent_start" });
						emitRpcEvent(child, { type: "agent_end" });
					}
				}
			});

			const manager = new ThreadManager({
				PI_THREADS_DEPTH: "0",
				PI_THREADS_MAX_DEPTH: "2",
				PI_THREADS_MAX_THREADS: "8",
				PI_THREADS_PATH: "/root",
				PI_THREADS_ROOT_SESSION_ID: "test-root",
			} as NodeJS.ProcessEnv);

			await manager.start(
				{ action: "start", prompt: "initial", taskName: `idle_${mode}` },
				context(),
			);
			emitRpcEvent(child, { type: "agent_start" });
			emitRpcEvent(child, { type: "agent_end" });
			await new Promise<void>((resolve) => setImmediate(resolve));

			const sendOutcome = await manager.send({
				action: "send",
				id: `idle_${mode}`,
				mode,
				message: "again",
			});
			const outcome = await manager.wait({ action: "wait", id: `idle_${mode}`, timeoutMs: 20 });

			expect(sendOutcome.accepted).toBe(true);
			expect(sendPrompts).toHaveLength(1);
			expect(sendPrompts[0]).toEqual(
				expect.objectContaining({ type: "prompt", message: "again", streamingBehavior }),
			);
			expect(outcome.timedOut).toBe(false);
			if (outcome.thread.state !== "live") return;
			expect(outcome.thread.phase).toBe("idle");
		},
	);

	it("starts a default follow-up prompt when a busy child becomes idle during send acceptance", async () => {
		const child = new FakeChildProcess();
		const requests: Record<string, unknown>[] = [];
		let promptCount = 0;
		let reportBusyState = false;
		let promptStartedAfterAcceptance = false;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			requests.push(request);
			if (request["type"] === "get_state") {
				const isStreaming = reportBusyState;
				if (reportBusyState) reportBusyState = false;
				respond(child, request, {
					sessionFile: "/tmp/send-race.jsonl",
					sessionId: "session-send-race",
					pendingMessageCount: 0,
					isStreaming,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") {
				promptCount++;
				if (promptCount === 2) {
					emitRpcEvent(child, { type: "agent_end" });
					respond(child, request);
					promptStartedAfterAcceptance = true;
					return;
				}

				respond(child, request);
			}
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "send_busy_idle_race" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		reportBusyState = true;
		await new Promise<void>((resolve) => setImmediate(resolve));

		const requestCount = requests.length;
		const sendOutcome = await manager.send({
			action: "send",
			id: "send_busy_idle_race",
			message: "again",
		});
		expect(promptStartedAfterAcceptance).toBe(true);
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const outcome = await manager.wait({
			action: "wait",
			id: "send_busy_idle_race",
			timeoutMs: 20,
		});

		expect(sendOutcome.mode).toBe("follow_up");
		expect(
			requests.slice(requestCount, requestCount + 2).map((request) => request["type"]),
		).toEqual(["get_state", "prompt"]);
		expect(requests[requestCount + 1]).toEqual(
			expect.objectContaining({ type: "prompt", message: "again", streamingBehavior: "followUp" }),
		);
		expect(outcome.timedOut).toBe(false);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("idle");
	});

	it("does not attribute a previous turn finishing during send acceptance to the new send", async () => {
		const child = new FakeChildProcess();
		let reportBusyState = false;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/wait-send-prior-finish.jsonl",
					sessionId: "session-wait-send-prior-finish",
					pendingMessageCount: 0,
					isStreaming: reportBusyState,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt" && request["streamingBehavior"] === "followUp") {
				emitRpcEvent(child, { type: "agent_end" });
				reportBusyState = false;
				respond(child, request);
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_send_prior_finish" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		reportBusyState = true;
		await new Promise<void>((resolve) => setImmediate(resolve));

		const sendOutcome = await manager.send({
			action: "send",
			id: "wait_send_prior_finish",
			mode: "follow_up",
			message: "queued",
		});
		const outcome = await manager.wait({
			action: "wait",
			id: "wait_send_prior_finish",
			timeoutMs: 20,
		});

		expect(sendOutcome.accepted).toBe(true);
		if (sendOutcome.thread.state !== "live") return;
		expect(sendOutcome.thread.phase).toBe("busy");
		expect(outcome.timedOut).toBe(true);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("busy");
	});

	it("completes wait when a busy follow-up fully finishes before send resumes", async () => {
		const child = new FakeChildProcess();
		let reportBusyState = false;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/wait-busy-follow-up-fast.jsonl",
					sessionId: "session-wait-busy-follow-up-fast",
					pendingMessageCount: 0,
					isStreaming: reportBusyState,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt" && request["streamingBehavior"] === "followUp") {
				respond(child, request);
				emitRpcEvent(child, { type: "turn_end" });
				emitRpcEvent(child, { type: "message_start", message: { role: "user" } });
				emitRpcEvent(child, { type: "message_end", message: { role: "user" } });
				emitRpcEvent(child, { type: "message_start", message: { role: "assistant" } });
				emitRpcEvent(child, {
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "done" }] },
				});
				reportBusyState = false;
				emitRpcEvent(child, { type: "agent_end" });
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_busy_follow_up_fast" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		reportBusyState = true;
		await new Promise<void>((resolve) => setImmediate(resolve));

		const sendOutcome = await manager.send({
			action: "send",
			id: "wait_busy_follow_up_fast",
			mode: "follow_up",
			message: "queued",
		});
		const outcome = await manager.wait({
			action: "wait",
			id: "wait_busy_follow_up_fast",
			timeoutMs: 20,
		});

		expect(sendOutcome.accepted).toBe(true);
		expect(outcome.timedOut).toBe(false);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("idle");
	});

	it("does not attribute a previous turn finishing after send acceptance to the new send", async () => {
		const child = new FakeChildProcess();
		let reportBusyState = false;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/wait-send-prior-finish-after.jsonl",
					sessionId: "session-wait-send-prior-finish-after",
					pendingMessageCount: 0,
					isStreaming: reportBusyState,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_send_prior_finish_after" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		reportBusyState = true;
		await new Promise<void>((resolve) => setImmediate(resolve));

		await manager.send({
			action: "send",
			id: "wait_send_prior_finish_after",
			mode: "follow_up",
			message: "queued",
		});
		reportBusyState = false;
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		const outcome = await manager.wait({
			action: "wait",
			id: "wait_send_prior_finish_after",
			timeoutMs: 20,
		});

		expect(outcome.timedOut).toBe(true);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("busy");
	});

	it("eventually settles a busy send that produces no new-turn activity", async () => {
		const child = new FakeChildProcess();
		let promptCount = 0;
		let reportBusyState = false;
		let secondPromptAccepted = false;
		let postSendStateRefreshes = 0;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				if (secondPromptAccepted) postSendStateRefreshes++;
				respond(child, request, {
					sessionFile: "/tmp/wait-busy-no-activity.jsonl",
					sessionId: "session-wait-busy-no-activity",
					pendingMessageCount: 0,
					isStreaming: reportBusyState,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") {
				promptCount++;
				if (promptCount === 2) secondPromptAccepted = true;
				respond(child, request);
			}
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_busy_no_activity" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		reportBusyState = true;
		await new Promise<void>((resolve) => setImmediate(resolve));

		await manager.send({
			action: "send",
			id: "wait_busy_no_activity",
			mode: "follow_up",
			message: "/handled-without-turn",
		});
		reportBusyState = false;
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		const outcome = await manager.wait({
			action: "wait",
			id: "wait_busy_no_activity",
			timeoutMs: 600,
		});

		expect(postSendStateRefreshes).toBeGreaterThanOrEqual(2);
		expect(outcome.timedOut).toBe(false);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("idle");
	});

	it.each([
		["streaming", { isStreaming: true, isCompacting: false, pendingMessageCount: 0 }],
		["compacting", { isStreaming: false, isCompacting: true, pendingMessageCount: 0 }],
		["pending_messages", { isStreaming: false, isCompacting: false, pendingMessageCount: 1 }],
	] as const)(
		"refreshes stale %s state before an explicit follow_up send",
		async (_label, busyState) => {
			const child = new FakeChildProcess();
			const requests: Record<string, unknown>[] = [];
			let promptCount = 0;
			let reportBusyState = false;
			let secondPromptAccepted = false;
			spawnMock.mockReturnValue(child);
			attachRpc(child, (request) => {
				requests.push(request);
				if (request["type"] === "get_state") {
					const busy = reportBusyState && !secondPromptAccepted;
					respond(child, request, {
						sessionFile: "/tmp/send-explicit-stale.jsonl",
						sessionId: "session-send-explicit-stale",
						pendingMessageCount: busy ? busyState.pendingMessageCount : 0,
						isStreaming: busy ? busyState.isStreaming : false,
						isCompacting: busy ? busyState.isCompacting : false,
					});
					return;
				}

				if (request["type"] === "prompt") {
					promptCount++;
					if (promptCount === 2) {
						emitRpcEvent(child, { type: "agent_end" });
						respond(child, request);
						secondPromptAccepted = true;
						return;
					}

					respond(child, request);
				}
			});

			const manager = new ThreadManager({
				PI_THREADS_DEPTH: "0",
				PI_THREADS_MAX_DEPTH: "2",
				PI_THREADS_MAX_THREADS: "8",
				PI_THREADS_PATH: "/root",
				PI_THREADS_ROOT_SESSION_ID: "test-root",
			} as NodeJS.ProcessEnv);

			await manager.start(
				{ action: "start", prompt: "initial", taskName: "send_explicit_stale" },
				context(),
			);
			emitRpcEvent(child, { type: "agent_start" });
			emitRpcEvent(child, { type: "agent_end" });
			await new Promise<void>((resolve) => setImmediate(resolve));

			reportBusyState = true;
			const requestCount = requests.length;
			const sendOutcome = await manager.send({
				action: "send",
				id: "send_explicit_stale",
				mode: "follow_up",
				message: "queued",
			});
			const outcome = await manager.wait({
				action: "wait",
				id: "send_explicit_stale",
				timeoutMs: 20,
			});

			expect(sendOutcome.accepted).toBe(true);
			expect(
				requests.slice(requestCount, requestCount + 2).map((request) => request["type"]),
			).toEqual(["get_state", "prompt"]);
			expect(requests[requestCount + 1]).toEqual(
				expect.objectContaining({
					type: "prompt",
					message: "queued",
					streamingBehavior: "followUp",
				}),
			);
			if (sendOutcome.thread.state !== "live") return;
			expect(sendOutcome.thread.phase).toBe("busy");
			expect(outcome.timedOut).toBe(true);
			if (outcome.thread.state !== "live") return;
			expect(outcome.thread.phase).toBe("busy");
		},
	);

	it.each([
		["streaming", { isStreaming: true, isCompacting: false, pendingMessageCount: 0 }],
		["compacting", { isStreaming: false, isCompacting: true, pendingMessageCount: 0 }],
		["pending_messages", { isStreaming: false, isCompacting: false, pendingMessageCount: 1 }],
	])("refreshes %s state before defaulting an omitted-mode send", async (_label, busyState) => {
		const child = new FakeChildProcess();
		const requests: string[] = [];
		let reportBusyState = false;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			requests.push(String(request["type"]));
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/send-default.jsonl",
					sessionId: "session-send-default",
					pendingMessageCount: reportBusyState ? busyState.pendingMessageCount : 0,
					isStreaming: reportBusyState ? busyState.isStreaming : false,
					isCompacting: reportBusyState ? busyState.isCompacting : false,
				});
				return;
			}

			if (request["type"] === "prompt" || request["type"] === "follow_up") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "send_default" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		reportBusyState = true;
		const requestCount = requests.length;
		const outcome = await manager.send({ action: "send", id: "send_default", message: "again" });

		expect(outcome.mode).toBe("follow_up");
		expect(requests.slice(requestCount)).toEqual(["get_state", "prompt"]);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("busy");
	});

	it("does not report wait completion while messages are queued", async () => {
		const child = new FakeChildProcess();
		let pendingMessageCount = 0;
		let queuedStateRefreshes = 0;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				if (pendingMessageCount > 0) queuedStateRefreshes++;
				respond(child, request, {
					sessionFile: "/tmp/wait-queued.jsonl",
					sessionId: "session-wait-queued",
					pendingMessageCount,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start({ action: "start", prompt: "initial", taskName: "wait_queued" }, context());
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		pendingMessageCount = 1;
		const outcome = await manager.wait({ action: "wait", id: "wait_queued", timeoutMs: 20 });

		expect(queuedStateRefreshes).toBeGreaterThan(0);
		expect(outcome.timedOut).toBe(true);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("busy");
		expect(outcome.thread.session).toEqual({
			kind: "known",
			file: "/tmp/wait-queued.jsonl",
			id: "session-wait-queued",
			name: null,
			pendingMessageCount: 1,
		});
	});

	it("completes wait when an accepted send is observed queued and then drains", async () => {
		const child = new FakeChildProcess();
		let promptCount = 0;
		let secondPromptAccepted = false;
		let postSendStateRefreshes = 0;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				const pendingMessageCount = secondPromptAccepted && postSendStateRefreshes++ === 0 ? 1 : 0;
				respond(child, request, {
					sessionFile: "/tmp/wait-queued-drains.jsonl",
					sessionId: "session-wait-queued-drains",
					pendingMessageCount,
					isStreaming: false,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") {
				promptCount++;
				if (promptCount === 2) secondPromptAccepted = true;
				respond(child, request);
			}
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_queued_drains" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		await manager.send({ action: "send", id: "wait_queued_drains", message: "again" });
		const outcome = await manager.wait({
			action: "wait",
			id: "wait_queued_drains",
			timeoutMs: 600,
		});

		expect(postSendStateRefreshes).toBe(2);
		expect(outcome.timedOut).toBe(false);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("idle");
		expect(outcome.thread.session).toEqual({
			kind: "known",
			file: "/tmp/wait-queued-drains.jsonl",
			id: "session-wait-queued-drains",
			name: null,
			pendingMessageCount: 0,
		});
	});

	it("does not report wait completion while the child is compacting", async () => {
		const child = new FakeChildProcess();
		let isCompacting = false;
		let compactingStateRefreshes = 0;
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				if (isCompacting) compactingStateRefreshes++;
				respond(child, request, {
					sessionFile: "/tmp/wait-compacting.jsonl",
					sessionId: "session-wait-compacting",
					pendingMessageCount: 0,
					isStreaming: false,
					isCompacting,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await manager.start(
			{ action: "start", prompt: "initial", taskName: "wait_compacting" },
			context(),
		);
		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "agent_end" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		isCompacting = true;
		const outcome = await manager.wait({ action: "wait", id: "wait_compacting", timeoutMs: 20 });

		expect(compactingStateRefreshes).toBeGreaterThan(0);
		expect(outcome.timedOut).toBe(true);
		if (outcome.thread.state !== "live") return;
		expect(outcome.thread.phase).toBe("busy");
		expect(outcome.thread.session).toEqual({
			kind: "known",
			file: "/tmp/wait-compacting.jsonl",
			id: "session-wait-compacting",
			name: null,
			pendingMessageCount: 0,
		});
	});

	it("reports synchronous spawn failures", async () => {
		spawnMock.mockImplementation(() => {
			throw new Error("bad spawn");
		});

		const manager = new ThreadManager({
			PI_THREADS_DEPTH: "0",
			PI_THREADS_MAX_DEPTH: "2",
			PI_THREADS_MAX_THREADS: "8",
			PI_THREADS_PATH: "/root",
			PI_THREADS_ROOT_SESSION_ID: "test-root",
		} as NodeJS.ProcessEnv);

		await expect(
			manager.start({ action: "start", prompt: "spawn", taskName: "spawn" }, context()),
		).rejects.toThrow(/Unable to start child Pi process: bad spawn/u);
	});
});

describe("child cwd trust", () => {
	it("only inherits approval inside the parent cwd", () => {
		const parent = path.join(os.tmpdir(), "project");

		expect(shouldApproveChildCwd(true, parent, parent)).toBe(true);
		expect(shouldApproveChildCwd(true, parent, path.join(parent, "sub"))).toBe(true);
		expect(shouldApproveChildCwd(true, parent, path.join(parent, "..cache"))).toBe(true);
		expect(shouldApproveChildCwd(true, parent, path.join(parent, "..data", "current"))).toBe(true);
		expect(shouldApproveChildCwd(true, parent, `${parent}-sibling`)).toBe(false);
		expect(shouldApproveChildCwd(true, parent, path.join(parent, "..", "other"))).toBe(false);
		expect(shouldApproveChildCwd(false, parent, parent)).toBe(false);
	});

	it("does not inherit approval through a symlink that escapes the parent cwd", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-cwd-"));
		try {
			const parent = path.join(root, "parent");
			const outside = path.join(root, "outside");
			const link = path.join(parent, "outside_link");
			fs.mkdirSync(parent);
			fs.mkdirSync(outside);
			fs.symlinkSync(outside, link, "dir");

			expect(shouldApproveChildCwd(true, parent, link)).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
