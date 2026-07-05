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
		archived: false,
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
		archived: false,
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
		expect(notify).toHaveBeenCalledWith("Usage: /threads", "error");
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
		expect(notify).toHaveBeenCalledWith("Usage: /threads", "error");
	});

	it("opens the TUI browser as a native editor replacement", async () => {
		let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const list = vi.fn(() => [thread()]);
		const custom = vi.fn().mockResolvedValue(null);
		const pi = {
			registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				if (name === "threads") handler = options.handler;
			},
		} as unknown as ExtensionAPI;

		registerThreadsCommand(pi, { list } as unknown as ThreadManager);
		if (handler === undefined) throw new Error("/threads command was not registered");

		await handler("", {
			mode: "tui",
			hasUI: true,
			ui: { custom, notify: vi.fn() },
		} as unknown as ExtensionCommandContext);

		expect(list).toHaveBeenCalledWith({ action: "list", state: "all", visibility: "all" });
		expect(custom).toHaveBeenCalledWith(expect.any(Function));
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

	it("does not enter or switch sessions from the browser", () => {
		const liveThread = thread({
			phase: "busy",
			lastPartialText: "Still working through the plan.",
			session: {
				kind: "known",
				file: "/tmp/child.jsonl",
				id: "session-child",
				name: null,
				pendingMessageCount: null,
			},
		});
		const poll = vi.fn();
		const stop = vi.fn();
		const switchSession = vi.fn();
		const tree = component({ poll, stop }, [liveThread], {
			switchSession,
		} as unknown as ExtensionCommandContext);

		tree.handleInput("\r");
		const rendered = tree.render(180).join("\n");

		expect(rendered).toContain("Pi Threads");
		expect(rendered).toContain("Selected: alpha  /root/alpha");
		expect(rendered).toContain("live/busy");
		expect(rendered).toContain("Still working through the plan.");
		expect(rendered).not.toContain("Attached read-only");
		expect(rendered).not.toContain("READ ONLY");
		expect(poll).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(switchSession).not.toHaveBeenCalled();
	});

	it("renders the browser at a natural panel height instead of padding to the viewport", () => {
		const tree = component({}, [thread()]);
		const lines = tree.render(100);

		expect(lines.length).toBeLessThan(24);
		expect(lines.every((line) => line.length <= 100)).toBe(true);
		expect(lines.join("\n")).toContain("Pi Threads");
		expect(lines.join("\n")).not.toContain("READ ONLY");
	});

	it("does not switch sessions for closed threads", () => {
		const stoppedThread = closedThread({
			session: {
				kind: "known",
				file: "/tmp/child.jsonl",
				id: "session-child",
				name: null,
				pendingMessageCount: null,
			},
		});
		const switchSession = vi.fn();
		const tree = component({}, [stoppedThread], {
			switchSession,
		} as unknown as ExtensionCommandContext);

		tree.handleInput("\r");
		const rendered = tree.render(160).join("\n");

		expect(rendered).toContain("Selected: alpha  /root/alpha");
		expect(rendered).toContain("closed/stopped");
		expect(rendered).not.toContain("Attached read-only");
		expect(switchSession).not.toHaveBeenCalled();
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

	it("hides archived threads by default and toggles archived visibility with ctrl+v", () => {
		const active = thread();
		const archived = closedThread({
			id: asThreadId("thread_111111111111"),
			name: "beta",
			taskName: "beta",
			path: asThreadPath("/root/beta"),
			archived: true,
		});
		const tree = component({}, [active, archived]);

		expect(tree.render(160).join("\n")).toContain("/root/alpha");
		expect(tree.render(160).join("\n")).not.toContain("/root/beta");

		tree.handleInput("\x16");
		expect(tree.render(160).join("\n")).not.toContain("/root/alpha");
		expect(tree.render(160).join("\n")).toContain("/root/beta");
		expect(tree.render(160).join("\n")).toContain("[archived]");

		tree.handleInput("\x16");
		expect(tree.render(160).join("\n")).toContain("/root/alpha");
		expect(tree.render(160).join("\n")).toContain("/root/beta");
	});

	it("shows stale state, summaries, and event timeline for the selected thread", () => {
		const staleThread = closedThread({
			exit: { kind: "stale", message: "restored" },
			lastAssistantText: "Finished reviewing the docs.",
			session: {
				kind: "known",
				file: "/tmp/child.jsonl",
				id: "session-child",
				name: null,
				pendingMessageCount: null,
			},
			recentEvents: [
				{
					seq: 1,
					at: "2026-01-01T00:00:00.000Z",
					type: "assistant_message",
					text: "Finished reviewing the docs.",
				},
			],
		});
		const tree = component({}, [staleThread]);
		const rendered = tree.render(180).join("\n");

		expect(rendered).toContain("stale");
		expect(rendered).toContain("State: closed/stale");
		expect(rendered).toContain("Saved session: yes");
		expect(rendered).toContain("Result: Finished reviewing the docs.");
		expect(rendered).toContain("Timeline:");
		expect(rendered).toContain("assistant: Finished reviewing the docs.");
	});

	it("does not expose resume, fork, or archive keyboard controls", () => {
		const resume = vi.fn();
		const fork = vi.fn();
		const archive = vi.fn();
		const tree = component({ resume, fork, archive } as Partial<ThreadManager>, [closedThread()]);

		tree.handleInput("\x15");
		tree.handleInput("\x06");
		tree.handleInput("\x01");

		expect(resume).not.toHaveBeenCalled();
		expect(fork).not.toHaveBeenCalled();
		expect(archive).not.toHaveBeenCalled();
	});

	it("navigates between visible parent and child threads with arrow keys", () => {
		const parent = thread();
		const child = thread({
			id: asThreadId("thread_111111111111"),
			name: "beta",
			taskName: "beta",
			path: asThreadPath("/root/alpha/beta"),
			parentPath: asThreadPath("/root/alpha"),
		});
		const tree = component({}, [parent, child]);

		expect(tree.render(180).join("\n")).toContain("Selected: alpha  /root/alpha");
		tree.handleInput("\x1b[C");
		expect(tree.render(180).join("\n")).toContain("Selected: beta  /root/alpha/beta");
		tree.handleInput("\x1b[D");
		expect(tree.render(180).join("\n")).toContain("Selected: alpha  /root/alpha");
	});
});
