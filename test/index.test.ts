import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { asThreadId, asThreadPath, type ThreadSnapshot } from "../src/domain.ts";
import { PI_THREAD_ENTRY_MESSAGE_TYPE } from "../src/threads-command.ts";
import extension from "../src/index.ts";
import {
	getThreadsSessionShutdownAction,
	prepareThreadsForSessionShutdown,
	shouldShutdownThreadsOnSessionShutdown,
	syncThreadManagerScope,
} from "../src/index.ts";
import type { ThreadManager } from "../src/thread-manager.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function ctx(
	branch: readonly unknown[] = [],
	sessionFile: string | undefined = undefined,
): ExtensionContext {
	return {
		ui: { notify: () => undefined },
		sessionManager: { getBranch: () => branch, getSessionFile: () => sessionFile },
	} as unknown as ExtensionContext;
}

function event(input: Partial<SessionShutdownEvent>): SessionShutdownEvent {
	return { type: "session_shutdown", reason: "resume", ...input } as SessionShutdownEvent;
}

function threadSnapshot(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
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
		session: {
			kind: "known",
			file: "/tmp/child.jsonl",
			id: "session-id",
			name: null,
			pendingMessageCount: null,
		},
		lastAssistantText: null,
		recentEvents: [],
		stderrTail: "",
		...overrides,
	} as ThreadSnapshot;
}

function managerWithThread(thread: ThreadSnapshot | null): ThreadManager {
	return {
		list: () => (thread === null ? [] : [thread]),
		findBySessionFile: (sessionFile: string) =>
			thread?.session.kind === "known" && thread.session.file === sessionFile ? thread : undefined,
	} as unknown as ThreadManager;
}

describe("session shutdown thread lifecycle", () => {
	it("preserves thread management when switching into a closed managed child session", () => {
		expect(
			shouldShutdownThreadsOnSessionShutdown(
				event({ targetSessionFile: "/tmp/child.jsonl" }),
				ctx(),
				managerWithThread(threadSnapshot()),
			),
		).toBe(false);
	});

	it("stops a live managed child before a direct session resume", async () => {
		const liveThread = threadSnapshot({
			state: "live",
			pid: 123,
			phase: "busy",
			lastPartialText: null,
		} as Partial<ThreadSnapshot>);
		const closedThread = threadSnapshot();
		const stop = async () => ({ kind: "stopped", thread: closedThread as ThreadSnapshot });
		const calls: unknown[] = [];
		const manager = {
			list: () => [liveThread],
			findBySessionFile: (sessionFile: string) =>
				liveThread.session.kind === "known" && liveThread.session.file === sessionFile
					? liveThread
					: undefined,
			stop: (command: unknown) => {
				calls.push(command);
				return stop();
			},
		} as unknown as ThreadManager;

		expect(
			getThreadsSessionShutdownAction(
				event({ targetSessionFile: "/tmp/child.jsonl" }),
				ctx(),
				manager,
			).kind,
		).toBe("stop_target");
		expect(
			shouldShutdownThreadsOnSessionShutdown(
				event({ targetSessionFile: "/tmp/child.jsonl" }),
				ctx(),
				manager,
			),
		).toBe(true);
		await expect(
			prepareThreadsForSessionShutdown(
				event({ targetSessionFile: "/tmp/child.jsonl" }),
				ctx(),
				manager,
			),
		).resolves.toBe(false);
		expect(calls).toEqual([{ action: "stop", id: "/root/alpha", force: false }]);
	});

	it("preserves live thread management when returning from a thread session", () => {
		const branch = [
			{
				type: "custom_message",
				customType: PI_THREAD_ENTRY_MESSAGE_TYPE,
				details: { parentSessionFile: "/tmp/parent.jsonl" },
			},
		];

		expect(
			shouldShutdownThreadsOnSessionShutdown(
				event({ targetSessionFile: "/tmp/parent.jsonl" }),
				ctx(branch),
				managerWithThread(null),
			),
		).toBe(false);
	});

	it("rebinds the process manager to the entered thread scope", () => {
		const manager = {
			findBySessionFile: () => threadSnapshot(),
			rebindScope: () => undefined,
			resetScope: () => undefined,
		} as unknown as ThreadManager;
		const calls: unknown[] = [];
		manager.rebindScope = (scope) => {
			calls.push(scope);
		};

		syncThreadManagerScope(ctx([], "/tmp/child.jsonl"), manager);

		expect(calls).toEqual([
			{
				currentPath: "/root/alpha",
				depth: 1,
				selfThreadId: "thread_012345abcdef",
			},
		]);
	});

	it("still shuts down threads for quits and unrelated session resumes", () => {
		expect(
			shouldShutdownThreadsOnSessionShutdown(
				event({ reason: "quit" }),
				ctx(),
				managerWithThread(threadSnapshot()),
			),
		).toBe(true);

		expect(
			shouldShutdownThreadsOnSessionShutdown(
				event({ targetSessionFile: "/tmp/other.jsonl" }),
				ctx(),
				managerWithThread(threadSnapshot()),
			),
		).toBe(true);
	});
});

describe("thread tool rendering", () => {
	it("renders an expanded empty list instead of a blank component", () => {
		let renderResult:
			| ((
					result: unknown,
					options: { expanded: boolean; isPartial: boolean },
					theme: Theme,
			  ) => {
					render: (width: number) => string[];
			  })
			| undefined;
		const pi = {
			registerCommand: () => undefined,
			registerMessageRenderer: () => undefined,
			on: () => undefined,
			registerTool: (tool: { renderResult: typeof renderResult }) => {
				renderResult = tool.renderResult;
			},
		} as unknown as ExtensionAPI;

		extension(pi);

		const component = renderResult?.(
			{ content: [], details: { kind: "listed", threads: [] } },
			{ expanded: true, isPartial: false },
			theme,
		);

		expect(component?.render(80).join("\n")).toContain("No threads");
	});
});
