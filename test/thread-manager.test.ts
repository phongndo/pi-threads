import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asThreadId, asThreadPath, type ThreadSnapshot } from "../src/domain.ts";

const { execFileMock, spawnMock } = vi.hoisted(() => ({
	execFileMock: vi.fn(
		(
			_command: string,
			_args: readonly string[],
			callback?: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			queueMicrotask(() => callback?.(null, "", ""));
			return {};
		},
	),
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return { ...actual, execFile: execFileMock, spawn: spawnMock };
});

const { shouldApproveChildCwd } = await import("../src/arg-policy.ts");
const { PI_THREAD_REGISTRY_ENTRY_TYPE, ThreadManager } = await import("../src/thread-manager.ts");

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
		cwd: options.cwd ?? process.cwd(),
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

function mockMissingProcessKill(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "kill").mockImplementation((() => {
		const error = new Error("mock ESRCH") as NodeJS.ErrnoException;
		error.code = "ESRCH";
		throw error;
	}) as typeof process.kill);
}

async function withPlatform<T>(
	platform: NodeJS.Platform,
	callback: () => T | Promise<T>,
): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform });
	try {
		return await callback();
	} finally {
		if (descriptor !== undefined) Object.defineProperty(process, "platform", descriptor);
	}
}

function managerEnvironment(): NodeJS.ProcessEnv {
	return {
		PI_THREADS_DEPTH: "0",
		PI_THREADS_MAX_DEPTH: "2",
		PI_THREADS_MAX_THREADS: "8",
		PI_THREADS_PATH: "/root",
		PI_THREADS_ROOT_SESSION_ID: "test-root",
	} as NodeJS.ProcessEnv;
}

function mockResponsiveChild(sessionId: string): FakeChildProcess {
	const child = new FakeChildProcess();
	spawnMock.mockReturnValueOnce(child);
	attachRpc(child, (request) => {
		if (request["type"] === "get_state") {
			respond(child, request, {
				sessionFile: `/tmp/${sessionId}.jsonl`,
				sessionId,
				pendingMessageCount: 0,
				isStreaming: false,
			});
			return;
		}

		if (request["type"] === "prompt") respond(child, request);
		if (request["type"] === "abort") respond(child, request);
	});
	return child;
}

function registryEntry(snapshot: ThreadSnapshot, scope?: { readonly sessionId: string }): unknown {
	return {
		type: "custom",
		customType: PI_THREAD_REGISTRY_ENTRY_TYPE,
		data: {
			version: 1,
			kind: "thread_snapshot",
			snapshot,
			...(scope === undefined ? {} : { scope }),
		},
	};
}

function writeSessionHeader(file: string, id = "session-test", cwd = process.cwd()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
	);
}

function closedKnownSnapshot(options: {
	readonly id: string;
	readonly name?: string;
	readonly taskName: string;
	readonly threadPath: string;
	readonly parentPath?: string;
	readonly parentThreadId?: string | null;
	readonly depth?: number;
	readonly cwd: string;
	readonly sessionFile: string;
	readonly sessionId: string;
}): ThreadSnapshot {
	return {
		state: "closed",
		id: asThreadId(options.id),
		name: options.name ?? options.taskName,
		taskName: options.taskName,
		path: asThreadPath(options.threadPath),
		parentPath: asThreadPath(options.parentPath ?? "/root"),
		parentThreadId:
			options.parentThreadId === undefined || options.parentThreadId === null
				? null
				: asThreadId(options.parentThreadId),
		depth: options.depth ?? 1,
		archived: false,
		cwd: options.cwd,
		args: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		lastEventAt: "2026-01-01T00:00:00.000Z",
		exit: { kind: "stale", message: "restored" },
		session: {
			kind: "known",
			file: options.sessionFile,
			id: options.sessionId,
			name: null,
			pendingMessageCount: null,
		},
		lastAssistantText: null,
		recentEvents: [],
		stderrTail: "",
	};
}

describe("ThreadManager session metadata", () => {
	let processKillSpy: ReturnType<typeof vi.spyOn> | null = null;

	beforeEach(() => {
		spawnMock.mockReset();
		execFileMock.mockClear();
		processKillSpy = mockMissingProcessKill();
	});

	afterEach(() => {
		processKillSpy?.mockRestore();
		processKillSpy = null;
	});

	it("reports unknown references with accepted forms and known suggestions", async () => {
		const manager = new ThreadManager(managerEnvironment());
		mockResponsiveChild("session-alpha");
		await manager.start({ action: "start", prompt: "work", taskName: "alpha" }, context());

		await expect(manager.poll("missing")).rejects.toThrow(/Unknown thread reference: "missing"/u);
		await expect(manager.poll("missing")).rejects.toThrow(/Accepted reference forms/u);
		await expect(manager.poll("missing")).rejects.toThrow(/\/root\/alpha/u);
		await expect(manager.poll("missing")).rejects.toThrow(/\{ "action": "list" \}/u);
	});

	it("reports ambiguous references with candidate paths", async () => {
		const manager = new ThreadManager(managerEnvironment());
		manager.rebindScope({
			currentPath: asThreadPath("/root/alpha"),
			depth: 1,
			selfThreadId: null,
		});
		mockResponsiveChild("session-alpha-shared");
		await manager.start({ action: "start", prompt: "one", taskName: "shared" }, context());

		manager.rebindScope({
			currentPath: asThreadPath("/root/beta"),
			depth: 1,
			selfThreadId: null,
		});
		mockResponsiveChild("session-beta-shared");
		await manager.start({ action: "start", prompt: "two", taskName: "shared" }, context());
		manager.resetScope();

		await expect(manager.poll("shared")).rejects.toThrow(
			/Ambiguous thread reference "shared".*Candidate paths: \/root\/alpha\/shared, \/root\/beta\/shared.*Repair/u,
		);
	});

	it("reports duplicate taskName paths with a repair hint", async () => {
		const manager = new ThreadManager(managerEnvironment());
		mockResponsiveChild("session-alpha");
		await manager.start({ action: "start", prompt: "one", taskName: "alpha" }, context());

		await expect(
			manager.start({ action: "start", prompt: "two", taskName: "alpha" }, context()),
		).rejects.toThrow(
			/Thread path already exists: \/root\/alpha.*choose a unique start\.taskName/u,
		);
	});

	it("starts POSIX children detached so process-tree cleanup can signal the group", async () => {
		await withPlatform("linux", async () => {
			const manager = new ThreadManager(managerEnvironment());
			mockResponsiveChild("session-detached-posix");

			await manager.start({ action: "start", prompt: "work", taskName: "posix" }, context());

			expect(spawnMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ detached: true }));
		});
	});

	it("does not detach Windows children", async () => {
		await withPlatform("win32", async () => {
			const manager = new ThreadManager(managerEnvironment());
			mockResponsiveChild("session-detached-windows");

			await manager.start({ action: "start", prompt: "work", taskName: "windows" }, context());

			expect(spawnMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ detached: false }));
		});
	});

	it("stops POSIX process groups with SIGTERM when process-group signaling works", async () => {
		await withPlatform("linux", async () => {
			const child = mockResponsiveChild("session-stop-group");
			processKillSpy?.mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
				queueMicrotask(() => child.emit("close", null, signal ?? null));
				return true;
			}) as typeof process.kill);
			const manager = new ThreadManager(managerEnvironment());

			await manager.start({ action: "start", prompt: "work", taskName: "group" }, context());
			await manager.stop({ action: "stop", id: "/root/group" });

			expect(processKillSpy).toHaveBeenCalledWith(-child.pid, "SIGTERM");
			expect(child.kill).not.toHaveBeenCalledWith("SIGTERM");
		});
	});

	it("falls back to direct child kills when POSIX process-group signaling fails", async () => {
		await withPlatform("linux", async () => {
			const child = mockResponsiveChild("session-stop-fallback");
			const manager = new ThreadManager(managerEnvironment());

			await manager.start({ action: "start", prompt: "work", taskName: "fallback" }, context());
			await manager.stop({ action: "stop", id: "/root/fallback" });

			expect(processKillSpy).toHaveBeenCalledWith(-child.pid, "SIGTERM");
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		});
	});

	it("force-stops POSIX process groups with SIGKILL", async () => {
		await withPlatform("linux", async () => {
			const child = mockResponsiveChild("session-force-group");
			processKillSpy?.mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
				queueMicrotask(() => child.emit("close", null, signal ?? null));
				return true;
			}) as typeof process.kill);
			const manager = new ThreadManager(managerEnvironment());

			await manager.start({ action: "start", prompt: "work", taskName: "force_group" }, context());
			await manager.stop({ action: "stop", id: "/root/force_group", force: true });

			expect(processKillSpy).toHaveBeenCalledWith(-child.pid, "SIGKILL");
			expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
		});
	});

	it("uses taskkill to force-stop Windows process trees", async () => {
		await withPlatform("win32", async () => {
			const child = mockResponsiveChild("session-windows-taskkill");
			execFileMock.mockImplementationOnce(
				(
					_command: string,
					_args: readonly string[],
					callback?: (error: Error | null, stdout: string, stderr: string) => void,
				) => {
					queueMicrotask(() => {
						callback?.(null, "", "");
						child.emit("close", null, "SIGKILL");
					});
					return {};
				},
			);
			const manager = new ThreadManager(managerEnvironment());

			await manager.start({ action: "start", prompt: "work", taskName: "win_force" }, context());
			await manager.stop({ action: "stop", id: "/root/win_force", force: true });

			expect(execFileMock).toHaveBeenCalledWith(
				"taskkill.exe",
				["/PID", String(child.pid), "/T", "/F"],
				expect.any(Function),
			);
			expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
		});
	});

	it("falls back to direct child SIGKILL when Windows taskkill fails", async () => {
		await withPlatform("win32", async () => {
			const child = mockResponsiveChild("session-windows-taskkill-fallback");
			execFileMock.mockImplementationOnce(
				(
					_command: string,
					_args: readonly string[],
					callback?: (error: Error | null, stdout: string, stderr: string) => void,
				) => {
					queueMicrotask(() => callback?.(new Error("taskkill failed"), "", ""));
					return {};
				},
			);
			const manager = new ThreadManager(managerEnvironment());

			await manager.start(
				{ action: "start", prompt: "work", taskName: "win_force_fallback" },
				context(),
			);
			await manager.stop({ action: "stop", id: "/root/win_force_fallback", force: true });

			expect(execFileMock).toHaveBeenCalledWith(
				"taskkill.exe",
				["/PID", String(child.pid), "/T", "/F"],
				expect.any(Function),
			);
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		});
	});

	it("keeps the per-session live thread concurrency limit", async () => {
		const manager = new ThreadManager({
			...managerEnvironment(),
			PI_THREADS_MAX_THREADS: "1",
		});
		mockResponsiveChild("session-alpha");

		await manager.start({ action: "start", prompt: "one", taskName: "alpha" }, context());

		await expect(
			manager.start({ action: "start", prompt: "two", taskName: "beta" }, context()),
		).rejects.toThrow(/pi-threads live thread limit reached: 1\/1/u);
		await expect(manager.fork({ action: "fork" }, context())).rejects.toThrow(
			/pi-threads live thread limit reached: 1\/1/u,
		);
		expect(spawnMock).toHaveBeenCalledTimes(1);

		await manager.stop({ action: "stop", id: "/root/alpha" });
		mockResponsiveChild("session-beta");

		await expect(
			manager.start({ action: "start", prompt: "two", taskName: "beta" }, context()),
		).resolves.toMatchObject({ thread: { path: "/root/beta" } });
		expect(spawnMock).toHaveBeenCalledTimes(2);
	});

	it("awaits an in-flight cleanup before enforcing the live thread limit", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const oldChild = new FakeChildProcess();
			spawnMock.mockReturnValueOnce(oldChild);
			attachRpc(oldChild, (request) => {
				if (request["type"] === "get_state") {
					respond(oldChild, request, {
						sessionFile: "/tmp/session-old-cleanup.jsonl",
						sessionId: "session-old-cleanup",
						pendingMessageCount: 0,
						isStreaming: false,
					});
					return;
				}

				if (request["type"] === "prompt") respond(oldChild, request);
				// Keep abort pending so cleanup remains in flight while start is called.
			});
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_MAX_THREADS: "1",
				PI_THREADS_LIVE_TIMEOUT_MS: "1000",
			});

			await manager.start({ action: "start", prompt: "old", taskName: "old" }, context());
			await vi.advanceTimersByTimeAsync(1000);
			expect(manager.list({ action: "list", state: "live" })).toHaveLength(1);

			mockResponsiveChild("session-new-cleanup");
			const started = manager
				.start({ action: "start", prompt: "new", taskName: "new" }, context())
				.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				);

			await vi.advanceTimersByTimeAsync(1499);
			expect(spawnMock).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1);
			const result = await started;
			if (result.status === "rejected") throw result.reason;

			expect(oldChild.kill).toHaveBeenCalledWith("SIGTERM");
			expect(result.value.thread).toMatchObject({ path: "/root/new", state: "live" });
			expect(spawnMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-checks for newly expired threads after awaiting an in-flight cleanup", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const firstChild = new FakeChildProcess();
			let firstAbortRequest: Record<string, unknown> | null = null;
			let resolveFirstAbortSeen!: () => void;
			const firstAbortSeen = new Promise<void>((resolve) => {
				resolveFirstAbortSeen = resolve;
			});
			spawnMock.mockReturnValueOnce(firstChild);
			attachRpc(firstChild, (request) => {
				if (request["type"] === "get_state") {
					respond(firstChild, request, {
						sessionFile: "/tmp/session-first-cleanup.jsonl",
						sessionId: "session-first-cleanup",
						pendingMessageCount: 0,
						isStreaming: false,
					});
					return;
				}

				if (request["type"] === "prompt") respond(firstChild, request);
				if (request["type"] === "abort") {
					firstAbortRequest = request;
					resolveFirstAbortSeen();
				}
			});
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_MAX_THREADS: "2",
				PI_THREADS_LIVE_TIMEOUT_MS: "1000",
			});

			await manager.start({ action: "start", prompt: "first", taskName: "first" }, context());
			await vi.advanceTimersByTimeAsync(500);
			const secondChild = mockResponsiveChild("session-second-cleanup");
			await manager.start({ action: "start", prompt: "second", taskName: "second" }, context());

			await vi.advanceTimersByTimeAsync(500);
			await firstAbortSeen;

			mockResponsiveChild("session-third-cleanup");
			const started = manager
				.start({ action: "start", prompt: "third", taskName: "third" }, context())
				.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				);

			await vi.advanceTimersByTimeAsync(500);
			expect(secondChild.kill).not.toHaveBeenCalled();
			expect(spawnMock).toHaveBeenCalledTimes(2);

			if (firstAbortRequest === null) throw new Error("expected first abort request");
			respond(firstChild, firstAbortRequest);
			const result = await started;
			if (result.status === "rejected") throw result.reason;

			expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
			expect(secondChild.kill).toHaveBeenCalledWith("SIGTERM");
			expect(result.value.thread).toMatchObject({ path: "/root/third", state: "live" });
			expect(spawnMock).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the recursive thread depth limit", async () => {
		const manager = new ThreadManager({
			...managerEnvironment(),
			PI_THREADS_DEPTH: "2",
			PI_THREADS_MAX_DEPTH: "2",
		});

		await expect(
			manager.start({ action: "start", prompt: "too deep", taskName: "too_deep" }, context()),
		).rejects.toThrow(/recursion depth 2 has reached PI_THREADS_MAX_DEPTH=2/u);
		await expect(manager.fork({ action: "fork" }, context())).rejects.toThrow(
			/recursion depth 2 has reached PI_THREADS_MAX_DEPTH=2/u,
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("auto-generates task names from display names when taskName is omitted", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-default-cwd-"));
		try {
			const manager = new ThreadManager(managerEnvironment());
			mockResponsiveChild("session-review-api");

			const outcome = await manager.start(
				{
					action: "start",
					prompt: "Review API docs for stale examples",
					name: "Review API Docs!",
				},
				context({ cwd: root }),
			);

			expect(outcome.thread.taskName).toBe("review_api_docs");
			expect(outcome.thread.path).toBe("/root/review_api_docs");
			expect(outcome.thread.name).toBe("Review API Docs!");
			const args = spawnMock.mock.calls[0]?.[1] as readonly string[];
			expect(args[args.indexOf("--name") + 1]).toBe("Review API Docs!");
			expect(spawnMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ cwd: root }));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("auto-generates unique task names and display names from prompts", async () => {
		const manager = new ThreadManager(managerEnvironment());
		mockResponsiveChild("session-auth-1");

		const first = await manager.start(
			{ action: "start", prompt: "Find the auth refresh code" },
			context(),
		);
		mockResponsiveChild("session-auth-2");
		const second = await manager.start(
			{ action: "start", prompt: "Find the auth refresh code" },
			context(),
		);

		expect(first.thread.taskName).toBe("find_the_auth_refresh_code");
		expect(first.thread.path).toBe("/root/find_the_auth_refresh_code");
		expect(first.thread.name).toBe("Find the auth refresh code");
		expect(second.thread.taskName).toBe("find_the_auth_refresh_code_2");
		expect(second.thread.path).toBe("/root/find_the_auth_refresh_code_2");
	});

	it("falls back to a short id when no useful task text is available", async () => {
		const manager = new ThreadManager(managerEnvironment());
		mockResponsiveChild("session-fallback");

		const outcome = await manager.start({ action: "start", prompt: "!!!" }, context());

		expect(outcome.thread.taskName).toMatch(/^thread_[0-9a-f]{6}$/u);
		expect(outcome.thread.path).toBe(`/root/${outcome.thread.taskName}`);
		expect(outcome.thread.name).toMatch(/^thread [0-9a-f]{6}$/u);
	});

	it("validates child cwd exists and is a directory", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-cwd-"));
		try {
			const filePath = path.join(root, "file.txt");
			fs.writeFileSync(filePath, "not a directory");
			const manager = new ThreadManager(managerEnvironment());

			await expect(
				manager.start(
					{ action: "start", prompt: "missing", taskName: "missing", cwd: "missing" },
					context({ cwd: root }),
				),
			).rejects.toThrow(/Invalid child cwd: .*missing.*existing directory/u);
			await expect(
				manager.start(
					{ action: "start", prompt: "file", taskName: "file", cwd: "file.txt" },
					context({ cwd: root }),
				),
			).rejects.toThrow(/Invalid child cwd: .*file\.txt is not a directory.*Repair/u);
			expect(spawnMock).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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

	it("persists managed thread snapshots and hydrates live snapshots as stale", async () => {
		const manager = new ThreadManager(managerEnvironment());
		const snapshots: ThreadSnapshot[] = [];
		manager.setPersistence({ appendSnapshot: (snapshot) => snapshots.push(snapshot) });
		mockResponsiveChild("session-alpha");

		const outcome = await manager.start(
			{ action: "start", prompt: "work", taskName: "alpha" },
			context(),
		);
		const latest = snapshots.at(-1);
		if (latest === undefined) throw new Error("expected a persisted snapshot");

		const restoredManager = new ThreadManager(managerEnvironment());
		restoredManager.hydrateFromSession({
			sessionManager: { getBranch: () => [registryEntry(latest)] },
		} as unknown as ExtensionContext);

		const restored = restoredManager.list({ action: "list", visibility: "all" })[0];
		expect(restored).toEqual(
			expect.objectContaining({
				state: "closed",
				id: outcome.thread.id,
				path: "/root/alpha",
				exit: expect.objectContaining({ kind: "stale" }),
			}),
		);
	});

	it("persists live result and poll refresh updates to the registry", async () => {
		const manager = new ThreadManager(managerEnvironment());
		const snapshots: ThreadSnapshot[] = [];
		manager.setPersistence({ appendSnapshot: (snapshot) => snapshots.push(snapshot) });
		const child = mockResponsiveChild("session-alpha");

		await manager.start({ action: "start", prompt: "work", taskName: "alpha" }, context());
		snapshots.length = 0;

		emitRpcEvent(child, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		const resultSnapshot = snapshots.at(-1);
		if (resultSnapshot === undefined) throw new Error("expected a live result snapshot");
		expect(resultSnapshot).toEqual(
			expect.objectContaining({ state: "live", lastAssistantText: "Done" }),
		);
		expect(resultSnapshot.recentEvents).toContainEqual(
			expect.objectContaining({ type: "assistant_message", text: "Done" }),
		);

		emitRpcEvent(child, { type: "agent_start" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		snapshots.length = 0;

		await manager.poll("alpha");

		const refreshSnapshot = snapshots.at(-1);
		if (refreshSnapshot === undefined) throw new Error("expected a poll refresh snapshot");
		expect(refreshSnapshot).toEqual(expect.objectContaining({ state: "live", phase: "idle" }));
		expect(refreshSnapshot.recentEvents.map((event) => event.type)).toContain("turn_completed");
	});

	it("truncates oversized assistant output in persisted registry snapshots only", async () => {
		const manager = new ThreadManager(managerEnvironment());
		const snapshots: ThreadSnapshot[] = [];
		manager.setPersistence({ appendSnapshot: (snapshot) => snapshots.push(snapshot) });
		const child = mockResponsiveChild("session-alpha");

		await manager.start({ action: "start", prompt: "work", taskName: "alpha" }, context());
		snapshots.length = 0;

		const longText = "x".repeat(30_000);
		emitRpcEvent(child, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: longText }] },
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		const persisted = snapshots.at(-1);
		if (persisted === undefined) throw new Error("expected a persisted snapshot");
		expect(persisted.lastAssistantText).not.toBeNull();
		expect(persisted.lastAssistantText?.length).toBeLessThan(longText.length);
		expect(persisted.lastAssistantText).toContain("[truncated");

		const inMemory = manager.list({ action: "list", state: "all" })[0];
		expect(inMemory?.lastAssistantText).toBe(longText);
	});

	it("does not downgrade in-memory output when hydrating truncated registry snapshots", async () => {
		const manager = new ThreadManager(managerEnvironment());
		const snapshots: ThreadSnapshot[] = [];
		manager.setPersistence({ appendSnapshot: (snapshot) => snapshots.push(snapshot) });
		const child = mockResponsiveChild("session-alpha");

		await manager.start({ action: "start", prompt: "work", taskName: "alpha" }, context());

		const longText = "x".repeat(30_000);
		emitRpcEvent(child, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: longText }] },
		});
		child.emit("close", 0, null);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const latest = snapshots.at(-1);
		if (latest === undefined) throw new Error("expected a persisted snapshot");
		expect(latest.state).toBe("closed");
		expect(latest.lastAssistantText).toContain("[truncated");
		expect(manager.list({ action: "list", state: "all" })[0]?.lastAssistantText).toBe(longText);

		manager.hydrateFromSession({
			sessionManager: { getBranch: () => [registryEntry(latest)] },
		} as unknown as ExtensionContext);

		expect(manager.list({ action: "list", state: "all" })[0]?.lastAssistantText).toBe(longText);
	});

	it("forgets closed threads on clearThreads so a later session starts clean", async () => {
		const manager = new ThreadManager(managerEnvironment());
		const child = mockResponsiveChild("session-alpha");

		await manager.start({ action: "start", prompt: "work", taskName: "alpha" }, context());
		child.emit("close", 0, null);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(manager.list({ action: "list", state: "all" })).toHaveLength(1);

		manager.clearThreads();

		expect(manager.list({ action: "list", state: "all", visibility: "all" })).toHaveLength(0);
	});

	it("keeps background persistence bound to the thread owner's session after switches", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-owner-session-"));
		try {
			const rootSessionFile = path.join(root, "root.jsonl");
			const manager = new ThreadManager(managerEnvironment());
			const writes: Array<{
				readonly path: string;
				readonly scope: unknown;
				readonly target: unknown;
			}> = [];
			manager.setPersistence({
				appendSnapshot: (snapshot, scope, target) => {
					writes.push({ path: snapshot.path, scope, target });
				},
			});
			manager.hydrateFromSession({
				sessionManager: {
					getBranch: () => [],
					getSessionId: () => "session-root",
					getSessionFile: () => rootSessionFile,
					getSessionDir: () => root,
				},
			} as unknown as ExtensionContext);

			mockResponsiveChild("session-alpha");
			const alpha = await manager.start(
				{ action: "start", prompt: "alpha", taskName: "alpha" },
				context(),
			);
			const betaChild = mockResponsiveChild("session-beta");
			await manager.start({ action: "start", prompt: "beta", taskName: "beta" }, context());
			writes.length = 0;

			manager.hydrateFromSession({
				sessionManager: {
					getBranch: () => [],
					getSessionId: () => "session-alpha",
					getSessionFile: () => "/tmp/session-alpha.jsonl",
					getSessionDir: () => root,
				},
			} as unknown as ExtensionContext);
			manager.rebindScope({
				currentPath: alpha.thread.path,
				depth: alpha.thread.depth,
				selfThreadId: alpha.thread.id,
			});

			emitRpcEvent(betaChild, { type: "agent_start" });
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect(writes.at(-1)).toEqual({
				path: "/root/beta",
				scope: { sessionId: "session-root" },
				target: expect.objectContaining({
					sessionId: "session-root",
					sessionFile: rootSessionFile,
					isCurrentSession: false,
				}),
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps starts bound to the captured registry owner when cleanup awaits", async () => {
		vi.useFakeTimers();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-cleanup-owner-"));
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const rootSessionFile = path.join(root, "root.jsonl");
			const otherSessionFile = path.join(root, "other.jsonl");
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_LIVE_TIMEOUT_MS: "1",
			});
			const writes: Array<{
				readonly path: string;
				readonly scope: unknown;
				readonly target: unknown;
			}> = [];
			manager.setPersistence({
				appendSnapshot: (snapshot, scope, target) => {
					writes.push({ path: snapshot.path, scope, target });
				},
			});
			manager.hydrateFromSession({
				sessionManager: {
					getBranch: () => [],
					getSessionId: () => "session-root",
					getSessionFile: () => rootSessionFile,
					getSessionDir: () => root,
				},
			} as unknown as ExtensionContext);

			const expiredChild = new FakeChildProcess();
			let abortRequest: Record<string, unknown> | null = null;
			let resolveAbortSeen!: () => void;
			const abortSeen = new Promise<void>((resolve) => {
				resolveAbortSeen = resolve;
			});
			spawnMock.mockReturnValueOnce(expiredChild);
			attachRpc(expiredChild, (request) => {
				if (request["type"] === "get_state") {
					respond(expiredChild, request, {
						sessionFile: "/tmp/session-expired.jsonl",
						sessionId: "session-expired",
						pendingMessageCount: 0,
						isStreaming: false,
					});
					return;
				}
				if (request["type"] === "prompt") {
					respond(expiredChild, request);
					return;
				}
				if (request["type"] === "abort") {
					abortRequest = request;
					resolveAbortSeen();
				}
			});

			await manager.start({ action: "start", prompt: "expire me", taskName: "expired" }, context());
			vi.setSystemTime(new Date("2026-01-01T00:00:00.002Z"));

			const newChild = new FakeChildProcess();
			spawnMock.mockReturnValueOnce(newChild);
			attachRpc(newChild, (request) => {
				if (request["type"] === "get_state") {
					respond(newChild, request, {
						sessionFile: "/tmp/session-new.jsonl",
						sessionId: "session-new",
						pendingMessageCount: 0,
						isStreaming: false,
					});
					return;
				}
				if (request["type"] === "prompt") respond(newChild, request);
			});

			const start = manager.start(
				{ action: "start", prompt: "new work", taskName: "new_work" },
				context(),
			);
			await abortSeen;

			manager.hydrateFromSession({
				sessionManager: {
					getBranch: () => [],
					getSessionId: () => "session-other",
					getSessionFile: () => otherSessionFile,
					getSessionDir: () => root,
				},
			} as unknown as ExtensionContext);

			if (abortRequest === null) throw new Error("expected cleanup abort request");
			respond(expiredChild, abortRequest);

			await expect(start).resolves.toMatchObject({ thread: { path: "/root/new_work" } });
			expect(writes.find((write) => write.path === "/root/new_work")).toEqual({
				path: "/root/new_work",
				scope: { sessionId: "session-root" },
				target: expect.objectContaining({
					sessionId: "session-root",
					sessionFile: rootSessionFile,
					isCurrentSession: false,
				}),
			});
		} finally {
			vi.useRealTimers();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not re-create already hydrated stale snapshots", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
			const liveSnapshot: ThreadSnapshot = {
				state: "live",
				id: asThreadId("thread_abcdef012345"),
				name: "alpha",
				taskName: "alpha",
				path: asThreadPath("/root/alpha"),
				parentPath: asThreadPath("/root"),
				parentThreadId: null,
				depth: 1,
				archived: false,
				cwd: process.cwd(),
				args: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				lastEventAt: "2026-01-01T00:00:00.000Z",
				pid: 12_345,
				phase: "idle",
				session: { kind: "unknown" },
				lastAssistantText: null,
				lastPartialText: null,
				recentEvents: [
					{
						seq: 0,
						at: "2026-01-01T00:00:00.000Z",
						type: "thread_started",
						pid: 12_345,
					},
				],
				stderrTail: "",
			};
			const sessionManager = { getBranch: () => [registryEntry(liveSnapshot)] };
			const manager = new ThreadManager(managerEnvironment());

			manager.hydrateFromSession({ sessionManager } as unknown as ExtensionContext);
			const first = manager.list({ action: "list", visibility: "all" })[0];
			expect(first).toBeDefined();
			if (first === undefined) return;
			expect(first).toEqual(
				expect.objectContaining({
					state: "closed",
					lastEventAt: liveSnapshot.lastEventAt,
					exit: expect.objectContaining({ kind: "stale" }),
				}),
			);
			expect(first.recentEvents.at(-1)).toEqual(
				expect.objectContaining({
					seq: 1,
					at: liveSnapshot.lastEventAt,
					type: "thread_closed",
					exit: expect.objectContaining({ kind: "stale" }),
				}),
			);

			const onChange = vi.fn();
			manager.onChange(onChange);
			vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));

			manager.hydrateFromSession({ sessionManager } as unknown as ExtensionContext);

			expect(manager.list({ action: "list", visibility: "all" })[0]).toEqual(first);
			expect(onChange).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not hydrate registry snapshots copied from fork source sessions", () => {
		const snapshot: ThreadSnapshot = {
			state: "closed",
			id: asThreadId("thread_012345abcdef"),
			name: "alpha",
			taskName: "alpha",
			path: asThreadPath("/root/alpha"),
			parentPath: asThreadPath("/root"),
			parentThreadId: null,
			depth: 1,
			archived: false,
			cwd: process.cwd(),
			args: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			lastEventAt: "2026-01-01T00:00:00.000Z",
			exit: { kind: "exited", code: 0, signal: null },
			session: { kind: "unknown" },
			lastAssistantText: null,
			recentEvents: [],
			stderrTail: "",
		};
		const manager = new ThreadManager(managerEnvironment());

		manager.hydrateFromSession({
			sessionManager: {
				getBranch: () => [registryEntry(snapshot, { sessionId: "session-source" })],
				getHeader: () => ({ type: "session", parentSession: "/tmp/source.jsonl" }),
				getSessionId: () => "session-fork",
			},
		} as unknown as ExtensionContext);

		expect(manager.list({ action: "list", visibility: "all" })).toEqual([]);
	});

	it("ignores legacy root registries copied into forked sessions", () => {
		const snapshot: ThreadSnapshot = {
			state: "closed",
			id: asThreadId("thread_012345abcdef"),
			name: "alpha",
			taskName: "alpha",
			path: asThreadPath("/root/alpha"),
			parentPath: asThreadPath("/root"),
			parentThreadId: null,
			depth: 1,
			archived: false,
			cwd: process.cwd(),
			args: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			lastEventAt: "2026-01-01T00:00:00.000Z",
			exit: { kind: "exited", code: 0, signal: null },
			session: { kind: "unknown" },
			lastAssistantText: null,
			recentEvents: [],
			stderrTail: "",
		};
		const manager = new ThreadManager(managerEnvironment());

		manager.hydrateFromSession({
			sessionManager: {
				getBranch: () => [registryEntry(snapshot)],
				getHeader: () => ({ type: "session", parentSession: "/tmp/source.jsonl" }),
				getSessionId: () => "session-fork",
			},
		} as unknown as ExtensionContext);

		expect(manager.list({ action: "list", visibility: "all" })).toEqual([]);
	});

	it("pre-creates child Pi sessions with native parentSession metadata", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-parent-session-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const sessionDir = path.join(root, "sessions");
			writeSessionHeader(parentSessionFile, "session-parent", root);
			const child = new FakeChildProcess();
			let childSessionFile: string | undefined;
			spawnMock.mockReturnValueOnce(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					const args = spawnMock.mock.calls[0]?.[1] as readonly string[];
					childSessionFile = args[args.indexOf("--session") + 1];
					respond(child, request, {
						sessionFile: childSessionFile,
						sessionId: "session-child",
						pendingMessageCount: 0,
						isStreaming: false,
					});
					return;
				}
				if (request["type"] === "prompt") respond(child, request);
			});

			await new ThreadManager(managerEnvironment()).start(
				{ action: "start", prompt: "work", taskName: "child" },
				{
					...context({ cwd: root }),
					sessionManager: {
						getBranch: () => [],
						getSessionFile: () => parentSessionFile,
						getSessionDir: () => sessionDir,
					},
				} as unknown as ExtensionContext,
			);

			expect(childSessionFile).toBeDefined();
			const header = JSON.parse(fs.readFileSync(childSessionFile!, "utf8").split("\n")[0]!);
			expect(header).toEqual(
				expect.objectContaining({
					type: "session",
					cwd: root,
					parentSession: parentSessionFile,
				}),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("materializes an unflushed current Pi session before forking it", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-current-fork-"));
		try {
			const sessionDir = path.join(root, "sessions");
			const sessionManager = SessionManager.create(root, sessionDir);
			const sourceSessionFile = sessionManager.getSessionFile();
			if (sourceSessionFile === undefined) throw new Error("expected a planned session file");
			sessionManager.appendMessage({
				role: "user",
				content: "fork this first turn",
				timestamp: Date.now(),
			});
			expect(fs.existsSync(sourceSessionFile)).toBe(false);

			const child = new FakeChildProcess();
			let childSessionFile: string | undefined;
			spawnMock.mockReturnValueOnce(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					const args = spawnMock.mock.calls[0]?.[1] as readonly string[];
					childSessionFile = args[args.indexOf("--session") + 1];
					respond(child, request, {
						sessionFile: childSessionFile,
						sessionId: "session-fork",
						pendingMessageCount: 0,
						isStreaming: false,
					});
				}
			});

			const outcome = await new ThreadManager(managerEnvironment()).fork(
				{ action: "fork", taskName: "first_turn" },
				{
					...context({ cwd: root }),
					sessionManager,
				} as unknown as ExtensionContext,
			);

			expect(outcome.sourceSessionFile).toBe(sourceSessionFile);
			expect(fs.existsSync(sourceSessionFile)).toBe(true);
			expect(childSessionFile).toBeDefined();
			expect(fs.existsSync(childSessionFile!)).toBe(true);
			const assistantMessage = {
				role: "assistant",
				content: [],
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
				stopReason: "stop",
				timestamp: Date.now(),
			} as Parameters<typeof sessionManager.appendMessage>[0];
			expect(() => sessionManager.appendMessage(assistantMessage)).not.toThrow();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates fork inputs before materializing fork session files", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-invalid-fork-"));
		try {
			const sessionDir = path.join(root, "sessions");
			const sessionManager = SessionManager.create(root, sessionDir);
			const sourceSessionFile = sessionManager.getSessionFile();
			if (sourceSessionFile === undefined) throw new Error("expected a planned session file");
			sessionManager.appendMessage({
				role: "user",
				content: "fork source",
				timestamp: Date.now(),
			});

			const existing: ThreadSnapshot = {
				state: "closed",
				id: asThreadId("thread_012345abcdef"),
				name: "dupe",
				taskName: "dupe",
				path: asThreadPath("/root/dupe"),
				parentPath: asThreadPath("/root"),
				parentThreadId: null,
				depth: 1,
				archived: false,
				cwd: root,
				args: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				lastEventAt: "2026-01-01T00:00:00.000Z",
				exit: { kind: "stale", message: "restored" },
				session: { kind: "unknown" },
				lastAssistantText: null,
				recentEvents: [],
				stderrTail: "",
			};
			const manager = new ThreadManager(managerEnvironment());
			manager.hydrateFromSession({
				sessionManager: { getBranch: () => [registryEntry(existing)] },
			} as unknown as ExtensionContext);
			const forkContext = {
				...context({ cwd: root }),
				sessionManager,
			} as unknown as ExtensionContext;

			await expect(manager.fork({ action: "fork", taskName: "dupe" }, forkContext)).rejects.toThrow(
				/Thread path already exists/u,
			);
			await expect(
				manager.fork(
					{ action: "fork", taskName: "fresh", args: ["--session", "/tmp/nope.jsonl"] },
					forkContext,
				),
			).rejects.toThrow(/Unsupported child Pi arg/u);

			expect(spawnMock).not.toHaveBeenCalled();
			expect(fs.existsSync(sourceSessionFile)).toBe(false);
			expect(fs.readdirSync(sessionDir)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resumes saved sessions without sending an implicit prompt", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-resume-"));
		try {
			const sessionFile = path.join(root, "child.jsonl");
			writeSessionHeader(sessionFile, "session-child", root);
			const snapshot: ThreadSnapshot = {
				state: "closed",
				id: asThreadId("thread_012345abcdef"),
				name: "alpha",
				taskName: "alpha",
				path: asThreadPath("/root/alpha"),
				parentPath: asThreadPath("/root"),
				parentThreadId: null,
				depth: 1,
				archived: false,
				cwd: root,
				args: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				lastEventAt: "2026-01-01T00:00:00.000Z",
				exit: { kind: "stale", message: "restored" },
				session: {
					kind: "known",
					file: sessionFile,
					id: "session-child",
					name: null,
					pendingMessageCount: null,
				},
				lastAssistantText: null,
				recentEvents: [],
				stderrTail: "",
			};
			const manager = new ThreadManager(managerEnvironment());
			manager.hydrateFromSession({
				sessionManager: { getBranch: () => [registryEntry(snapshot)] },
			} as unknown as ExtensionContext);

			const child = new FakeChildProcess();
			const requests: string[] = [];
			spawnMock.mockReturnValueOnce(child);
			attachRpc(child, (request) => {
				requests.push(String(request["type"]));
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile,
						sessionId: "session-child",
						pendingMessageCount: 0,
						isStreaming: false,
					});
				}
			});

			const outcome = await manager.resume(
				{ action: "resume", id: "/root/alpha" },
				context({ cwd: root }),
			);

			const args = spawnMock.mock.calls[0]?.[1] as readonly string[];
			expect(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2)).toEqual([
				"--session",
				sessionFile,
			]);
			expect(requests).toEqual(["get_state"]);
			expect(outcome.alreadyLive).toBe(false);
			expect(outcome.thread.state).toBe("live");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("coalesces overlapping resume calls for the same closed thread", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-resume-race-"));
		try {
			const sessionFile = path.join(root, "child.jsonl");
			writeSessionHeader(sessionFile, "session-child", root);
			const snapshot: ThreadSnapshot = {
				state: "closed",
				id: asThreadId("thread_012345abcdef"),
				name: "alpha",
				taskName: "alpha",
				path: asThreadPath("/root/alpha"),
				parentPath: asThreadPath("/root"),
				parentThreadId: null,
				depth: 1,
				archived: false,
				cwd: root,
				args: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				lastEventAt: "2026-01-01T00:00:00.000Z",
				exit: { kind: "stale", message: "restored" },
				session: {
					kind: "known",
					file: sessionFile,
					id: "session-child",
					name: null,
					pendingMessageCount: null,
				},
				lastAssistantText: null,
				recentEvents: [],
				stderrTail: "",
			};
			const manager = new ThreadManager(managerEnvironment());
			manager.hydrateFromSession({
				sessionManager: { getBranch: () => [registryEntry(snapshot)] },
			} as unknown as ExtensionContext);

			spawnMock.mockImplementation(() => {
				const child = new FakeChildProcess();
				attachRpc(child, (request) => {
					if (request["type"] === "get_state") {
						respond(child, request, {
							sessionFile,
							sessionId: "session-child",
							pendingMessageCount: 0,
							isStreaming: false,
						});
					}
				});
				return child;
			});

			const [first, second] = await Promise.all([
				manager.resume({ action: "resume", id: "/root/alpha" }, context({ cwd: root })),
				manager.resume({ action: "resume", id: "/root/alpha" }, context({ cwd: root })),
			]);

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(first).toMatchObject({ alreadyLive: false, thread: { state: "live" } });
			expect(second).toMatchObject({ alreadyLive: true, thread: { state: "live" } });
			expect(manager.list({ action: "list", state: "live" })).toHaveLength(1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("unarchives resumed sessions so live work remains visible", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-resume-archive-"));
		try {
			const sessionFile = path.join(root, "child.jsonl");
			writeSessionHeader(sessionFile, "session-child", root);
			const snapshot: ThreadSnapshot = {
				state: "closed",
				id: asThreadId("thread_012345abcdef"),
				name: "alpha",
				taskName: "alpha",
				path: asThreadPath("/root/alpha"),
				parentPath: asThreadPath("/root"),
				parentThreadId: null,
				depth: 1,
				archived: true,
				cwd: root,
				args: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				lastEventAt: "2026-01-01T00:00:00.000Z",
				exit: { kind: "stale", message: "restored" },
				session: {
					kind: "known",
					file: sessionFile,
					id: "session-child",
					name: null,
					pendingMessageCount: null,
				},
				lastAssistantText: null,
				recentEvents: [],
				stderrTail: "",
			};
			const manager = new ThreadManager(managerEnvironment());
			manager.hydrateFromSession({
				sessionManager: { getBranch: () => [registryEntry(snapshot)] },
			} as unknown as ExtensionContext);
			expect(manager.list({ action: "list" })).toEqual([]);

			const child = new FakeChildProcess();
			spawnMock.mockReturnValueOnce(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile,
						sessionId: "session-child",
						pendingMessageCount: 0,
						isStreaming: false,
					});
				}
			});

			const outcome = await manager.resume(
				{ action: "resume", id: "/root/alpha" },
				context({ cwd: root }),
			);

			expect(outcome.thread.archived).toBe(false);
			expect(manager.list({ action: "list" })).toHaveLength(1);
			expect(manager.list({ action: "list", visibility: "archived" })).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("archives completed threads as visibility state without deleting session files", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-archive-"));
		try {
			const sessionFile = path.join(root, "child.jsonl");
			writeSessionHeader(sessionFile, "session-child", root);
			const snapshot: ThreadSnapshot = {
				state: "closed",
				id: asThreadId("thread_012345abcdef"),
				name: "alpha",
				taskName: "alpha",
				path: asThreadPath("/root/alpha"),
				parentPath: asThreadPath("/root"),
				parentThreadId: null,
				depth: 1,
				archived: false,
				cwd: root,
				args: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				lastEventAt: "2026-01-01T00:00:00.000Z",
				exit: { kind: "exited", code: 0, signal: null },
				session: {
					kind: "known",
					file: sessionFile,
					id: "session-child",
					name: null,
					pendingMessageCount: null,
				},
				lastAssistantText: null,
				recentEvents: [],
				stderrTail: "",
			};
			const manager = new ThreadManager(managerEnvironment());
			manager.hydrateFromSession({
				sessionManager: { getBranch: () => [registryEntry(snapshot)] },
			} as unknown as ExtensionContext);

			const outcome = manager.archive({ action: "archive", id: "/root/alpha" });

			expect(outcome.archived).toBe(true);
			expect(manager.list({ action: "list" })).toEqual([]);
			expect(manager.list({ action: "list", visibility: "archived" })).toHaveLength(1);
			expect(fs.existsSync(sessionFile)).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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

	it("captures start scope before cleanup yields", async () => {
		const manager = new ThreadManager({
			...managerEnvironment(),
			PI_THREADS_MAX_DEPTH: "3",
		});
		manager.rebindScope({
			currentPath: asThreadPath("/root/alpha"),
			depth: 1,
			selfThreadId: asThreadId("thread_aaaaaaaaaaaa"),
		});
		mockResponsiveChild("session-alpha-child");

		const started = manager.start(
			{ action: "start", prompt: "nested", taskName: "child" },
			context(),
		);
		manager.rebindScope({
			currentPath: asThreadPath("/root/beta"),
			depth: 1,
			selfThreadId: asThreadId("thread_bbbbbbbbbbbb"),
		});

		const outcome = await started;

		expect(outcome.thread.path).toBe("/root/alpha/child");
		expect(outcome.thread.parentPath).toBe("/root/alpha");
		expect(outcome.thread.parentThreadId).toBe("thread_aaaaaaaaaaaa");
		expect(outcome.thread.depth).toBe(2);
		expect(spawnMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					PI_THREADS_PARENT_ID: "thread_aaaaaaaaaaaa",
					PI_THREADS_PARENT_PATH: "/root/alpha",
					PI_THREADS_PATH: "/root/alpha/child",
				}),
			}),
		);
	});

	it("captures fork scope and source before cleanup yields", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-fork-scope-race-"));
		try {
			const alphaSessionFile = path.join(root, "alpha-source.jsonl");
			const betaSessionFile = path.join(root, "beta-source.jsonl");
			writeSessionHeader(alphaSessionFile, "session-alpha-source", root);
			writeSessionHeader(betaSessionFile, "session-beta-source", root);
			const alphaSource = closedKnownSnapshot({
				id: "thread_aaaaaaaaaaaa",
				name: "Alpha source",
				taskName: "source",
				threadPath: "/root/alpha/source",
				parentPath: "/root/alpha",
				depth: 2,
				cwd: root,
				sessionFile: alphaSessionFile,
				sessionId: "session-alpha-source",
			});
			const betaSource = closedKnownSnapshot({
				id: "thread_bbbbbbbbbbbb",
				name: "Beta source",
				taskName: "source",
				threadPath: "/root/beta/source",
				parentPath: "/root/beta",
				depth: 2,
				cwd: root,
				sessionFile: betaSessionFile,
				sessionId: "session-beta-source",
			});
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_MAX_DEPTH: "3",
			});
			manager.hydrateFromSession({
				sessionManager: {
					getBranch: () => [registryEntry(alphaSource), registryEntry(betaSource)],
				},
			} as unknown as ExtensionContext);
			manager.rebindScope({
				currentPath: asThreadPath("/root/alpha"),
				depth: 1,
				selfThreadId: asThreadId("thread_111111111111"),
			});
			mockResponsiveChild("session-alpha-fork");

			const forked = manager.fork(
				{ action: "fork", id: "source", taskName: "forked" },
				context({ cwd: root }),
			);
			manager.rebindScope({
				currentPath: asThreadPath("/root/beta"),
				depth: 1,
				selfThreadId: asThreadId("thread_222222222222"),
			});

			const outcome = await forked;

			expect(outcome.sourceSessionFile).toBe(alphaSessionFile);
			expect(outcome.thread.path).toBe("/root/alpha/forked");
			expect(outcome.thread.parentPath).toBe("/root/alpha");
			expect(outcome.thread.parentThreadId).toBe("thread_111111111111");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("captures resume depth before cleanup yields", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-resume-scope-race-"));
		try {
			const sessionFile = path.join(root, "alpha.jsonl");
			writeSessionHeader(sessionFile, "session-alpha", root);
			const snapshot = closedKnownSnapshot({
				id: "thread_aaaaaaaaaaaa",
				taskName: "alpha",
				threadPath: "/root/alpha",
				cwd: root,
				sessionFile,
				sessionId: "session-alpha",
			});
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_MAX_DEPTH: "2",
			});
			manager.hydrateFromSession({
				sessionManager: { getBranch: () => [registryEntry(snapshot)] },
			} as unknown as ExtensionContext);
			const child = new FakeChildProcess();
			spawnMock.mockReturnValueOnce(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile,
						sessionId: "session-alpha",
						pendingMessageCount: 0,
						isStreaming: false,
					});
				}
			});

			const resumed = manager.resume({ action: "resume", id: "alpha" }, context({ cwd: root }));
			manager.rebindScope({
				currentPath: asThreadPath("/root/beta/deep"),
				depth: 2,
				selfThreadId: asThreadId("thread_bbbbbbbbbbbb"),
			});

			await expect(resumed).resolves.toMatchObject({
				alreadyLive: false,
				thread: { path: "/root/alpha", state: "live" },
			});
			expect(spawnMock).toHaveBeenCalledTimes(1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("propagates cleanup limits from the manager environment to children", async () => {
		const previousIdleCleanupMs = process.env["PI_THREADS_IDLE_CLEANUP_MS"];
		const previousLiveTimeoutMs = process.env["PI_THREADS_LIVE_TIMEOUT_MS"];
		let manager: InstanceType<typeof ThreadManager> | null = null;
		process.env["PI_THREADS_IDLE_CLEANUP_MS"] = "111";
		process.env["PI_THREADS_LIVE_TIMEOUT_MS"] = "222";

		try {
			mockResponsiveChild("session-cleanup-env");
			manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_IDLE_CLEANUP_MS: "3333",
				PI_THREADS_LIVE_TIMEOUT_MS: "4444",
			});

			await manager.start(
				{ action: "start", prompt: "cleanup env", taskName: "cleanup_env" },
				context(),
			);

			expect(spawnMock).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Array),
				expect.objectContaining({
					env: expect.objectContaining({
						PI_THREADS_IDLE_CLEANUP_MS: "3333",
						PI_THREADS_LIVE_TIMEOUT_MS: "4444",
					}),
				}),
			);
		} finally {
			await manager?.shutdown();
			if (previousIdleCleanupMs === undefined) delete process.env["PI_THREADS_IDLE_CLEANUP_MS"];
			else process.env["PI_THREADS_IDLE_CLEANUP_MS"] = previousIdleCleanupMs;
			if (previousLiveTimeoutMs === undefined) delete process.env["PI_THREADS_LIVE_TIMEOUT_MS"];
			else process.env["PI_THREADS_LIVE_TIMEOUT_MS"] = previousLiveTimeoutMs;
		}
	});

	it("allows list filters to use unmanaged path-only ancestors", async () => {
		const manager = new ThreadManager(managerEnvironment());
		manager.rebindScope({
			currentPath: asThreadPath("/root/alpha"),
			depth: 1,
			selfThreadId: asThreadId("thread_aaaaaaaaaaaa"),
		});
		mockResponsiveChild("session-beta");

		await manager.start({ action: "start", prompt: "nested", taskName: "beta" }, context());
		manager.resetScope();

		expect(
			manager.list({ action: "list", parent: "/root/alpha" }).map((thread) => thread.path),
		).toEqual(["/root/alpha/beta"]);
		expect(
			manager.list({ action: "list", ancestor: "/root/alpha" }).map((thread) => thread.path),
		).toEqual(["/root/alpha/beta"]);
		expect(manager.list({ action: "list", ancestor: "/root/missing" })).toEqual([]);
	});

	it("sends the initial prompt verbatim", async () => {
		const child = new FakeChildProcess();
		const requests: string[] = [];
		const prompts: string[] = [];
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			requests.push(String(request["type"]));
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/verbatim.jsonl",
					sessionId: "session-verbatim",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") {
				prompts.push(String(request["message"]));
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
			{ action: "start", prompt: "/review ignored\n\nUse only this prompt.", taskName: "verbatim" },
			context(),
		);

		expect(requests).toEqual(["get_state", "prompt"]);
		expect(prompts).toEqual(["/review ignored\n\nUse only this prompt."]);
	});

	it("validates start args before spawning a child", async () => {
		const manager = new ThreadManager(managerEnvironment());

		await expect(
			manager.start(
				{
					action: "start",
					prompt: "invalid args",
					taskName: "invalid_args",
					args: ["--session", "/tmp/nope.jsonl"],
				},
				context(),
			),
		).rejects.toThrow(/Unsupported child Pi arg.*--session/u);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("records canonical lifecycle events with stable sequence numbers", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/events.jsonl",
					sessionId: "session-events",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager(managerEnvironment());
		await manager.start({ action: "start", prompt: "events", taskName: "events" }, context());

		emitRpcEvent(child, { type: "agent_start" });
		emitRpcEvent(child, { type: "turn_start" });
		emitRpcEvent(child, { type: "message_start", message: { role: "assistant" } });
		emitRpcEvent(child, { type: "tool_execution_start", toolName: "read" });
		emitRpcEvent(child, { type: "tool_execution_end", toolName: "read", isError: false });
		emitRpcEvent(child, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Found it" }] },
		});
		emitRpcEvent(child, { type: "turn_end" });
		emitRpcEvent(child, { type: "agent_end" });
		emitRpcEvent(child, {
			type: "extension_ui_request",
			id: "ui-1",
			method: "confirm",
			title: "Approve?",
		});
		child.emit("close", 0, null);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const snapshot = manager.list({ action: "list", state: "all" })[0];
		expect(snapshot?.state).toBe("closed");
		expect(snapshot?.recentEvents.map((event) => event.type)).toEqual([
			"thread_started",
			"turn_started",
			"tool_started",
			"tool_completed",
			"assistant_message",
			"turn_completed",
			"ui_request",
			"thread_closed",
		]);
		expect(snapshot?.recentEvents.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(snapshot?.recentEvents).toContainEqual(
			expect.objectContaining({ type: "thread_started", pid: child.pid }),
		);
		expect(snapshot?.recentEvents).toContainEqual(
			expect.objectContaining({ type: "tool_started", toolName: "read" }),
		);
		expect(snapshot?.recentEvents).toContainEqual(
			expect.objectContaining({ type: "assistant_message", text: "Found it" }),
		);
		expect(snapshot?.recentEvents).toContainEqual(
			expect.objectContaining({ type: "ui_request", method: "confirm", autoCancelled: true }),
		);
		expect(snapshot?.recentEvents).toContainEqual(
			expect.objectContaining({
				type: "thread_closed",
				exit: { kind: "exited", code: 0, signal: null },
			}),
		);
	});

	it("infers turn completion from an idle poll when end events are missing", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/inferred-turn-completion.jsonl",
					sessionId: "session-inferred-turn-completion",
					pendingMessageCount: 0,
					isStreaming: false,
					isCompacting: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager(managerEnvironment());
		await manager.start(
			{ action: "start", prompt: "events", taskName: "inferred_turn_completion" },
			context(),
		);

		emitRpcEvent(child, { type: "agent_start" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		const polled = await manager.poll("inferred_turn_completion");
		expect(polled.recentEvents.map((event) => event.type)).toEqual([
			"thread_started",
			"turn_started",
			"turn_completed",
		]);

		emitRpcEvent(child, { type: "agent_start" });
		await new Promise<void>((resolve) => setImmediate(resolve));

		const refreshed = manager.list({ action: "list", state: "all" })[0];
		expect(refreshed?.recentEvents.map((event) => event.type)).toEqual([
			"thread_started",
			"turn_started",
			"turn_completed",
			"turn_started",
		]);
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

	it("optionally cleans up idle live children after the configured idle timeout", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const child = mockResponsiveChild("session-idle-cleanup");
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_IDLE_CLEANUP_MS: "1000",
			});

			await manager.start(
				{ action: "start", prompt: "idle cleanup", taskName: "idle_cleanup" },
				context(),
			);
			emitRpcEvent(child, { type: "agent_end" });

			await vi.advanceTimersByTimeAsync(999);
			expect(manager.list({ action: "list", state: "live" })).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(1);

			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(manager.list({ action: "list", state: "live" })).toEqual([]);
			expect(manager.list({ action: "list", state: "closed" })[0]).toMatchObject({
				state: "closed",
				exit: { kind: "stopped", signal: "SIGTERM" },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not idle-cleanup a child with an accepted send still pending", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const child = new FakeChildProcess();
			let reportBusyState = false;
			spawnMock.mockReturnValue(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile: "/tmp/session-idle-cleanup-pending-send.jsonl",
						sessionId: "session-idle-cleanup-pending-send",
						pendingMessageCount: 0,
						isStreaming: reportBusyState,
						isCompacting: false,
					});
					return;
				}

				if (request["type"] === "prompt") respond(child, request);
				if (request["type"] === "abort") respond(child, request);
			});
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_IDLE_CLEANUP_MS: "1000",
			});

			await manager.start(
				{
					action: "start",
					prompt: "idle cleanup pending send",
					taskName: "idle_cleanup_pending_send",
				},
				context(),
			);
			emitRpcEvent(child, { type: "agent_start" });
			reportBusyState = true;

			const sendOutcome = await manager.send({
				action: "send",
				id: "idle_cleanup_pending_send",
				mode: "follow_up",
				message: "queued",
			});
			expect(sendOutcome.accepted).toBe(true);

			reportBusyState = false;
			emitRpcEvent(child, { type: "agent_end" });
			expect(manager.list({ action: "list", state: "live" })[0]).toMatchObject({
				phase: "idle",
			});

			await vi.advanceTimersByTimeAsync(1000);

			expect(child.kill).not.toHaveBeenCalled();
			expect(manager.list({ action: "list", state: "live" })).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not idle-cleanup a child while a send is awaiting acceptance", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const child = new FakeChildProcess();
			let promptCount = 0;
			let sendPromptRequest: Record<string, unknown> | null = null;
			let resolveSendPromptSeen!: () => void;
			const sendPromptSeen = new Promise<void>((resolve) => {
				resolveSendPromptSeen = resolve;
			});
			spawnMock.mockReturnValue(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile: "/tmp/session-idle-cleanup-in-flight-send.jsonl",
						sessionId: "session-idle-cleanup-in-flight-send",
						pendingMessageCount: 0,
						isStreaming: false,
						isCompacting: false,
					});
					return;
				}

				if (request["type"] === "prompt") {
					promptCount++;
					if (promptCount === 1) {
						respond(child, request);
						return;
					}

					sendPromptRequest = request;
					resolveSendPromptSeen();
					return;
				}

				if (request["type"] === "abort") respond(child, request);
			});
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_IDLE_CLEANUP_MS: "1000",
			});

			await manager.start(
				{
					action: "start",
					prompt: "idle cleanup in-flight send",
					taskName: "idle_cleanup_in_flight_send",
				},
				context(),
			);
			emitRpcEvent(child, { type: "agent_end" });

			await vi.advanceTimersByTimeAsync(999);
			const sent = manager.send({
				action: "send",
				id: "idle_cleanup_in_flight_send",
				mode: "prompt",
				message: "queued",
			});
			await sendPromptSeen;

			await vi.advanceTimersByTimeAsync(1);

			expect(child.kill).not.toHaveBeenCalled();
			expect(manager.list({ action: "list", state: "live" })).toHaveLength(1);

			if (sendPromptRequest === null) throw new Error("expected send prompt request");
			respond(child, sendPromptRequest);
			await expect(sent).resolves.toMatchObject({ accepted: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not extend idle cleanup when an idle child is polled", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const child = mockResponsiveChild("session-idle-cleanup-poll");
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_IDLE_CLEANUP_MS: "1000",
			});

			await manager.start(
				{ action: "start", prompt: "idle cleanup poll", taskName: "idle_cleanup_poll" },
				context(),
			);
			emitRpcEvent(child, { type: "agent_end" });

			await vi.advanceTimersByTimeAsync(900);
			await manager.poll("/root/idle_cleanup_poll");

			await vi.advanceTimersByTimeAsync(100);

			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(manager.list({ action: "list", state: "live" })).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("extends idle cleanup after idle child-side activity", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const child = mockResponsiveChild("session-idle-cleanup-activity");
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_IDLE_CLEANUP_MS: "1000",
			});

			await manager.start(
				{ action: "start", prompt: "idle cleanup activity", taskName: "idle_cleanup_activity" },
				context(),
			);
			emitRpcEvent(child, { type: "agent_end" });

			await vi.advanceTimersByTimeAsync(900);
			emitRpcEvent(child, { type: "extension_ui_request", id: "ui-1", method: "notify" });

			await vi.advanceTimersByTimeAsync(999);
			expect(child.kill).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(manager.list({ action: "list", state: "live" })).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("bases idle cleanup on when a resumed child becomes idle", async () => {
		vi.useFakeTimers();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-idle-start-"));
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const sessionFile = path.join(root, "child.jsonl");
			writeSessionHeader(sessionFile, "session-idle-start", root);
			const snapshot: ThreadSnapshot = {
				state: "closed",
				id: asThreadId("thread_abcdef012345"),
				name: "alpha",
				taskName: "alpha",
				path: asThreadPath("/root/alpha"),
				parentPath: asThreadPath("/root"),
				parentThreadId: null,
				depth: 1,
				archived: false,
				cwd: root,
				args: [],
				createdAt: "2025-12-31T00:00:00.000Z",
				lastEventAt: "2025-12-31T00:00:00.000Z",
				exit: { kind: "stale", message: "restored" },
				session: {
					kind: "known",
					file: sessionFile,
					id: "session-idle-start",
					name: null,
					pendingMessageCount: null,
				},
				lastAssistantText: null,
				recentEvents: [],
				stderrTail: "",
			};
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_IDLE_CLEANUP_MS: "1000",
			});
			manager.hydrateFromSession({
				sessionManager: { getBranch: () => [registryEntry(snapshot)] },
			} as unknown as ExtensionContext);

			const child = new FakeChildProcess();
			spawnMock.mockReturnValueOnce(child);
			attachRpc(child, (request) => {
				if (request["type"] === "abort") respond(child, request);
				// Leave get_state unanswered so resume spends longer than the idle timeout starting.
			});

			const resumed = manager.resume(
				{ action: "resume", id: "/root/alpha" },
				context({ cwd: root }),
			);
			await vi.advanceTimersByTimeAsync(1500);

			await expect(resumed).resolves.toMatchObject({
				thread: { state: "live", phase: "idle" },
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(child.kill).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(999);
			expect(child.kill).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		} finally {
			vi.useRealTimers();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("optionally stops long-running live children after the configured live timeout", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const child = mockResponsiveChild("session-live-timeout");
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_LIVE_TIMEOUT_MS: "1000",
			});

			await manager.start(
				{ action: "start", prompt: "live timeout", taskName: "live_timeout" },
				context(),
			);

			await vi.advanceTimersByTimeAsync(1000);

			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(manager.list({ action: "list", state: "live" })).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("chunks cleanup timer delays larger than Node supports", async () => {
		const maxSetTimeoutDelayMs = 2_147_483_647;
		const oversizedLiveTimeoutMs = maxSetTimeoutDelayMs + 1_000;
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const child = mockResponsiveChild("session-large-live-timeout");
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_LIVE_TIMEOUT_MS: String(oversizedLiveTimeoutMs),
			});

			await manager.start(
				{ action: "start", prompt: "large timeout", taskName: "large_timeout" },
				context(),
			);

			const scheduledDelays = setTimeoutSpy.mock.calls
				.map(([, delayMs]) => delayMs)
				.filter((delayMs): delayMs is number => typeof delayMs === "number");
			expect(scheduledDelays).toContain(maxSetTimeoutDelayMs);
			expect(scheduledDelays.every((delayMs) => delayMs <= maxSetTimeoutDelayMs)).toBe(true);

			await vi.advanceTimersByTimeAsync(maxSetTimeoutDelayMs);
			expect(child.kill).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1_000);
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		} finally {
			setTimeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("bases live timeout on the current resume launch", async () => {
		vi.useFakeTimers();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-resume-timeout-"));
		try {
			vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
			const sessionFile = path.join(root, "child.jsonl");
			writeSessionHeader(sessionFile, "session-resume-timeout", root);
			const snapshot: ThreadSnapshot = {
				state: "closed",
				id: asThreadId("thread_012345abcdef"),
				name: "alpha",
				taskName: "alpha",
				path: asThreadPath("/root/alpha"),
				parentPath: asThreadPath("/root"),
				parentThreadId: null,
				depth: 1,
				archived: false,
				cwd: root,
				args: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				lastEventAt: "2026-01-01T00:00:00.000Z",
				exit: { kind: "stale", message: "restored" },
				session: {
					kind: "known",
					file: sessionFile,
					id: "session-resume-timeout",
					name: null,
					pendingMessageCount: null,
				},
				lastAssistantText: null,
				recentEvents: [],
				stderrTail: "",
			};
			const manager = new ThreadManager({
				...managerEnvironment(),
				PI_THREADS_LIVE_TIMEOUT_MS: "1000",
			});
			manager.hydrateFromSession({
				sessionManager: { getBranch: () => [registryEntry(snapshot)] },
			} as unknown as ExtensionContext);

			const child = new FakeChildProcess();
			spawnMock.mockReturnValueOnce(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile,
						sessionId: "session-resume-timeout",
						pendingMessageCount: 0,
						isStreaming: false,
					});
				}

				if (request["type"] === "abort") respond(child, request);
			});

			await manager.resume({ action: "resume", id: "/root/alpha" }, context({ cwd: root }));
			await vi.advanceTimersByTimeAsync(0);

			expect(child.kill).not.toHaveBeenCalled();
			expect(manager.list({ action: "list", state: "live" })).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(999);
			expect(child.kill).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);

			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(manager.list({ action: "list", state: "live" })).toEqual([]);
		} finally {
			vi.useRealTimers();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("forces a closed stopped snapshot when a live child ignores shutdown signals", async () => {
		const child = new FakeChildProcess();
		child.kill.mockImplementation(() => true);
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/stubborn.jsonl",
					sessionId: "session-stubborn",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt" || request["type"] === "abort") respond(child, request);
		});

		const manager = new ThreadManager(managerEnvironment());
		await manager.start({ action: "start", prompt: "stubborn", taskName: "stubborn" }, context());

		vi.useFakeTimers();
		try {
			const shutdown = manager.shutdown();
			await vi.advanceTimersByTimeAsync(2_000);
			await shutdown;
		} finally {
			vi.useRealTimers();
		}

		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(manager.list({ action: "list", state: "live" })).toEqual([]);
		expect(manager.list({ action: "list", state: "closed" })[0]).toMatchObject({
			state: "closed",
			exit: { kind: "stopped", signal: "SIGKILL" },
		});
	});

	it("ignores stale process close events after a force-closed thread is resumed", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-stale-close-"));
		try {
			const sessionFile = path.join(root, "child.jsonl");
			writeSessionHeader(sessionFile, "session-stale-close", root);
			const child = new FakeChildProcess();
			child.kill.mockImplementation(() => true);
			spawnMock.mockReturnValueOnce(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile,
						sessionId: "session-stale-close",
						pendingMessageCount: 0,
						isStreaming: false,
					});
					return;
				}

				if (request["type"] === "prompt" || request["type"] === "abort") respond(child, request);
			});

			const manager = new ThreadManager(managerEnvironment());
			await manager.start(
				{ action: "start", prompt: "stubborn", taskName: "stubborn" },
				context({ cwd: root }),
			);

			vi.useFakeTimers();
			try {
				const stopped = manager.stop({ action: "stop", id: "/root/stubborn" });
				await vi.advanceTimersByTimeAsync(2_000);
				await stopped;
			} finally {
				vi.useRealTimers();
			}

			const resumedChild = new FakeChildProcess();
			spawnMock.mockReturnValueOnce(resumedChild);
			attachRpc(resumedChild, (request) => {
				if (request["type"] === "get_state") {
					respond(resumedChild, request, {
						sessionFile,
						sessionId: "session-stale-close",
						pendingMessageCount: 0,
						isStreaming: false,
					});
				}
			});
			await manager.resume({ action: "resume", id: "/root/stubborn" }, context({ cwd: root }));

			child.emit("close", null, "SIGKILL");

			expect(resumedChild.kill).not.toHaveBeenCalled();
			expect(manager.list({ action: "list", state: "live" })).toHaveLength(1);
			expect(manager.list({ action: "list", state: "live" })[0]).toMatchObject({
				state: "live",
				path: "/root/stubborn",
			});
		} finally {
			vi.useRealTimers();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores stale process close events from superseded launches", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-superseded-close-"));
		try {
			const sessionFile = path.join(root, "child.jsonl");
			writeSessionHeader(sessionFile, "session-superseded-close", root);
			const child = new FakeChildProcess();
			child.kill.mockImplementation(() => true);
			spawnMock.mockReturnValueOnce(child);
			attachRpc(child, (request) => {
				if (request["type"] === "get_state") {
					respond(child, request, {
						sessionFile,
						sessionId: "session-superseded-close",
						pendingMessageCount: 0,
						isStreaming: false,
					});
					return;
				}

				if (request["type"] === "prompt") respond(child, request);
			});

			const manager = new ThreadManager(managerEnvironment());
			await manager.start(
				{ action: "start", prompt: "stubborn", taskName: "stubborn" },
				context({ cwd: root }),
			);

			vi.useFakeTimers();
			try {
				const stopped = manager.stop({ action: "stop", id: "/root/stubborn", force: true });
				await vi.advanceTimersByTimeAsync(1_000);
				await stopped;
			} finally {
				vi.useRealTimers();
			}

			const resumedChild = new FakeChildProcess();
			resumedChild.kill.mockImplementation(() => true);
			spawnMock.mockReturnValueOnce(resumedChild);
			attachRpc(resumedChild, (request) => {
				if (request["type"] === "get_state") {
					respond(resumedChild, request, {
						sessionFile,
						sessionId: "session-superseded-close",
						pendingMessageCount: 0,
						isStreaming: false,
					});
				}
			});
			await manager.resume({ action: "resume", id: "/root/stubborn" }, context({ cwd: root }));

			vi.useFakeTimers();
			try {
				const stopped = manager.stop({ action: "stop", id: "/root/stubborn", force: true });
				await vi.advanceTimersByTimeAsync(1_000);
				await stopped;
			} finally {
				vi.useRealTimers();
			}

			child.emit("close", 7, null);

			expect(manager.list({ action: "list", state: "closed" })[0]).toMatchObject({
				state: "closed",
				exit: { kind: "stopped", code: null, signal: "SIGKILL" },
			});
		} finally {
			vi.useRealTimers();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("throttles change notifications for streaming assistant updates", async () => {
		const child = new FakeChildProcess();
		spawnMock.mockReturnValue(child);
		attachRpc(child, (request) => {
			if (request["type"] === "get_state") {
				respond(child, request, {
					sessionFile: "/tmp/stream.jsonl",
					sessionId: "session-stream",
					pendingMessageCount: 0,
					isStreaming: false,
				});
				return;
			}

			if (request["type"] === "prompt") respond(child, request);
		});

		const manager = new ThreadManager(managerEnvironment());
		await manager.start({ action: "start", prompt: "stream", taskName: "stream" }, context());

		const onChange = vi.fn();
		manager.onChange(onChange);
		vi.useFakeTimers();
		try {
			emitRpcEvent(child, {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "hel" }] },
			});
			emitRpcEvent(child, {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
			});

			expect(onChange).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(249);
			expect(onChange).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange.mock.calls[0]?.[0][0]).toMatchObject({
				state: "live",
				lastPartialText: "hello",
			});

			emitRpcEvent(child, {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "hello!" }] },
			});
			await vi.advanceTimersByTimeAsync(250);

			expect(onChange).toHaveBeenCalledTimes(2);
			expect(onChange.mock.calls[1]?.[0][0]).toMatchObject({
				state: "live",
				lastPartialText: "hello!",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("forces no-approve for a child cwd outside the trusted parent cwd", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-outside-"));
		const parentCwd = path.join(root, "parent");
		const outsideCwd = path.join(root, "outside");
		fs.mkdirSync(parentCwd);
		fs.mkdirSync(outsideCwd);
		const child = new FakeChildProcess();
		try {
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
				context({ cwd: parentCwd }),
			);

			const args = spawnMock.mock.calls[0]?.[1] as readonly string[];
			expect(args).toContain("--no-approve");
			expect(args).not.toContain("--approve");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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
		const activeSessionCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-threads-active-"));
		fs.mkdirSync(path.join(activeSessionCwd, "child"));

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
			fs.rmSync(activeSessionCwd, { recursive: true, force: true });
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

	it("rejects direct wait timeouts outside the safe bound", async () => {
		const manager = new ThreadManager(managerEnvironment());
		mockResponsiveChild("session-wait-bound");
		await manager.start({ action: "start", prompt: "wait", taskName: "wait_bound" }, context());

		await expect(
			manager.wait({ action: "wait", id: "wait_bound", timeoutMs: 600_001 }),
		).rejects.toThrow(/Invalid wait timeoutMs.*0 to 600000/u);
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
			const pollOutcome = await manager.poll("send_explicit_stale");

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
			if (pollOutcome.state !== "live") return;
			expect(pollOutcome.phase).toBe("busy");
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
