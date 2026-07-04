import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	asThreadId,
	asThreadPath,
	toThreadRuntimeSnapshot,
	type ClosedThreadSnapshot,
	type LiveThreadSnapshot,
	type ThreadSnapshot,
} from "../src/domain.ts";
import { registerThreadsCommand, ThreadsTreeComponent } from "../src/threads-command.ts";
import type { ThreadManager } from "../src/thread-manager.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function thread(overrides: Partial<LiveThreadSnapshot> = {}): ThreadSnapshot {
	return {
		state: "live",
		id: asThreadId("thread_012345abcdef"),
		name: "alpha",
		taskName: "alpha",
		path: asThreadPath("/root/alpha"),
		parentPath: asThreadPath("/root"),
		parentThreadId: null,
		depth: 1,
		cwd: "/tmp/project",
		args: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		lastEventAt: "2026-01-01T00:00:00.000Z",
		pid: 123,
		phase: "idle",
		session: { kind: "unknown" },
		lastAssistantText: null,
		lastPartialText: null,
		recentEvents: [],
		stderrTail: "",
		...overrides,
	};
}

function closedThread(overrides: Partial<ClosedThreadSnapshot> = {}): ThreadSnapshot {
	return {
		state: "closed",
		id: asThreadId("thread_012345abcdef"),
		name: "alpha",
		taskName: "alpha",
		path: asThreadPath("/root/alpha"),
		parentPath: asThreadPath("/root"),
		parentThreadId: null,
		depth: 1,
		cwd: "/tmp/project",
		args: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		lastEventAt: "2026-01-01T00:00:00.000Z",
		exit: { kind: "stopped", code: null, signal: "SIGTERM" },
		session: { kind: "unknown" },
		lastAssistantText: null,
		recentEvents: [],
		stderrTail: "",
		...overrides,
	};
}

function component(
	manager: Partial<ThreadManager>,
	threads: readonly ThreadSnapshot[],
	ctx: Partial<ExtensionCommandContext> = {},
	done: (result: null) => void = vi.fn(),
) {
	const notify = vi.fn();
	const switchSession = vi.fn();
	const commandCtx = {
		ui: { notify },
		sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" },
		switchSession,
		...ctx,
	} as unknown as ExtensionCommandContext;
	return new ThreadsTreeComponent(
		{ requestRender: vi.fn() },
		theme,
		manager as ThreadManager,
		commandCtx,
		threads,
		"all",
		done,
	);
}

describe("/threads command", () => {
	it("rejects unknown arguments instead of falling back to all threads", async () => {
		let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const list = vi.fn(() => [thread()]);
		const notify = vi.fn();
		const pi = {
			registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				if (name === "threads") handler = options.handler;
			},
		} as unknown as ExtensionAPI;

		registerThreadsCommand(pi, { list } as unknown as ThreadManager);
		if (handler === undefined) throw new Error("/threads command was not registered");

		await handler("done", {
			mode: "print",
			hasUI: false,
			ui: { notify },
		} as unknown as ExtensionCommandContext);

		expect(list).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Usage: /threads [exit]", "error");
	});

	it("rejects removed state filter arguments", async () => {
		let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const list = vi.fn(() => [thread()]);
		const notify = vi.fn();
		const pi = {
			registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				if (name === "threads") handler = options.handler;
			},
		} as unknown as ExtensionAPI;

		registerThreadsCommand(pi, { list } as unknown as ThreadManager);
		if (handler === undefined) throw new Error("/threads command was not registered");

		await handler("live", {
			mode: "print",
			hasUI: false,
			ui: { notify },
		} as unknown as ExtensionCommandContext);

		expect(list).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Usage: /threads [exit]", "error");
	});

	it("routes /threads exit to the thread exit handler", async () => {
		let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const list = vi.fn(() => [thread()]);
		const exit = vi.fn();
		const pi = {
			registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				if (name === "threads") handler = options.handler;
			},
		} as unknown as ExtensionAPI;

		registerThreadsCommand(pi, { list } as unknown as ThreadManager, { exit });
		if (handler === undefined) throw new Error("/threads command was not registered");

		const ctx = {
			mode: "print",
			hasUI: false,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext;
		await handler("exit", ctx);

		expect(exit).toHaveBeenCalledWith(ctx);
		expect(list).not.toHaveBeenCalled();
	});

	it("warns instead of silently no-oping when /threads exit has no handler", async () => {
		let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const notify = vi.fn();
		const list = vi.fn(() => [thread()]);
		const pi = {
			registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				if (name === "threads") handler = options.handler;
			},
		} as unknown as ExtensionAPI;

		registerThreadsCommand(pi, { list } as unknown as ThreadManager);
		if (handler === undefined) throw new Error("/threads command was not registered");

		await handler("exit", {
			mode: "print",
			hasUI: false,
			ui: { notify },
		} as unknown as ExtensionCommandContext);

		expect(notify).toHaveBeenCalledWith("Thread exit is unavailable in this context", "warning");
		expect(list).not.toHaveBeenCalled();
	});
});

describe("ThreadsTreeComponent input", () => {
	it("treats s as search text instead of the stop shortcut", () => {
		const stop = vi.fn();
		const tree = component({ stop }, [thread()]);

		tree.handleInput("s");

		expect(stop).not.toHaveBeenCalled();
		expect(tree.render(120).join("\n")).toContain("Type to search: s");
	});

	it("uses a non-printable modified key for stopping the selected row", async () => {
		const stop = vi.fn().mockResolvedValue({ kind: "stopped", thread: thread() });
		const tree = component({ stop, list: () => [thread()] }, [thread()]);

		tree.handleInput("\x18");
		await Promise.resolve();

		expect(stop).toHaveBeenCalledWith({ action: "stop", id: "/root/alpha", force: false });
	});

	it("does not stop or switch into a live thread when opening", async () => {
		const liveThread = thread({
			phase: "busy",
			session: {
				kind: "known",
				file: "/tmp/child.jsonl",
				id: "session-child",
				name: null,
				pendingMessageCount: null,
			},
		});
		const poll = vi.fn().mockResolvedValue(liveThread);
		const stop = vi.fn();
		const switchSession = vi.fn();
		const notify = vi.fn();
		const tree = component({ poll, stop }, [liveThread], {
			ui: { notify },
			switchSession,
		} as unknown as ExtensionCommandContext);

		tree.handleInput("\r");
		await vi.waitFor(() => expect(poll).toHaveBeenCalledWith("/root/alpha"));

		expect(stop).not.toHaveBeenCalled();
		expect(switchSession).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("still live"), "warning");
	});

	it("does not enter a thread when the parent session is not saved", () => {
		const stoppedThread = closedThread({
			session: {
				kind: "known",
				file: "/tmp/child.jsonl",
				id: "session-child",
				name: null,
				pendingMessageCount: null,
			},
		});
		const poll = vi.fn().mockResolvedValue(stoppedThread);
		const switchSession = vi.fn();
		const notify = vi.fn();
		const done = vi.fn();
		const tree = component(
			{ poll },
			[stoppedThread],
			{
				ui: { notify },
				sessionManager: { getSessionFile: () => undefined },
				switchSession,
			} as unknown as ExtensionCommandContext,
			done,
		);

		tree.handleInput("\r");

		expect(poll).not.toHaveBeenCalled();
		expect(done).not.toHaveBeenCalled();
		expect(switchSession).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("no saved parent session"),
			"warning",
		);
	});

	it("opens a closed thread session without stopping it", async () => {
		const stoppedThread = closedThread({
			session: {
				kind: "known",
				file: "/tmp/child.jsonl",
				id: "session-child",
				name: null,
				pendingMessageCount: null,
			},
		});
		const poll = vi.fn().mockResolvedValue(stoppedThread);
		const stop = vi.fn();
		const switchSession = vi.fn().mockResolvedValue({ cancelled: false });
		const tree = component({ poll, stop }, [stoppedThread], {
			switchSession,
		} as unknown as ExtensionCommandContext);

		tree.handleInput("\r");
		await vi.waitFor(() => expect(switchSession).toHaveBeenCalled());

		expect(stop).not.toHaveBeenCalled();
		expect(switchSession).toHaveBeenCalledWith(
			"/tmp/child.jsonl",
			expect.objectContaining({ withSession: expect.any(Function) }),
		);
	});

	it("does not use a stale command context after the menu closes during stop", async () => {
		let stale = false;
		const notify = vi.fn();
		let resolveStop!: (outcome: {
			readonly kind: "stopped";
			readonly thread: ThreadSnapshot;
			readonly snapshot: ReturnType<typeof toThreadRuntimeSnapshot>;
		}) => void;
		const stop = vi.fn(
			() =>
				new Promise<{
					readonly kind: "stopped";
					readonly thread: ThreadSnapshot;
					readonly snapshot: ReturnType<typeof toThreadRuntimeSnapshot>;
				}>((resolve) => {
					resolveStop = resolve;
				}),
		);
		const done = vi.fn();
		const tree = component(
			{ stop },
			[thread()],
			{
				get ui() {
					if (stale) {
						throw new Error("This extension ctx is stale after session replacement or reload.");
					}
					return { notify };
				},
			} as unknown as ExtensionCommandContext,
			done,
		);

		const stopPromise = (
			tree as unknown as { readonly handleStop: () => Promise<void> }
		).handleStop();
		tree.handleInput("\x1b");
		stale = true;
		const stoppedThread = thread();
		resolveStop({
			kind: "stopped",
			thread: stoppedThread,
			snapshot: toThreadRuntimeSnapshot(stoppedThread),
		});

		await expect(stopPromise).resolves.toBeUndefined();
		expect(done).toHaveBeenCalledWith(null);
		expect(notify).not.toHaveBeenCalled();
	});
});
