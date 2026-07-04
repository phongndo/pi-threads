import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { asThreadId, asThreadPath, type ThreadSnapshot } from "../src/domain.ts";
import { PI_THREAD_ENTRY_MESSAGE_TYPE } from "../src/threads-command.ts";
import extension from "../src/index.ts";
import { PiThreadParamsSchema } from "../src/schema.ts";
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

const PROCESS_MANAGER_KEY = "__piThreadsProcessManager";

function useProcessManager(manager: ThreadManager): () => void {
	const store = globalThis as typeof globalThis & Record<string, unknown>;
	const previous = store[PROCESS_MANAGER_KEY];
	store[PROCESS_MANAGER_KEY] = manager;
	return () => {
		if (previous === undefined) {
			delete store[PROCESS_MANAGER_KEY];
		} else {
			store[PROCESS_MANAGER_KEY] = previous;
		}
	};
}

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

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function registeredThreadTools(): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		on: () => undefined,
		registerTool: (tool: RegisteredTool) => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	extension(pi);
	return tools;
}

function registeredThreadTool(): RegisteredTool {
	const tools = registeredThreadTools();
	const registered = tools.find((tool) => tool.name === "thread");
	if (registered === undefined) throw new Error("thread tool was not registered");
	return registered;
}

function registeredCommandHandlers(): Map<string, CommandHandler> {
	const handlers = new Map<string, CommandHandler>();
	const pi = {
		registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			handlers.set(name, options.handler);
		},
		registerMessageRenderer: () => undefined,
		on: () => undefined,
		registerTool: () => undefined,
	} as unknown as ExtensionAPI;

	extension(pi);
	return handlers;
}

function commandCtx(branch: readonly unknown[] = []): ExtensionCommandContext & {
	readonly notify: ReturnType<typeof vi.fn>;
	readonly shutdown: ReturnType<typeof vi.fn>;
	readonly switchSession: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn();
	const shutdown = vi.fn();
	const switchSession = vi.fn();
	return {
		notify,
		shutdown,
		switchSession,
		ui: { notify },
		sessionManager: { getBranch: () => branch, getSessionFile: () => "/tmp/current.jsonl" },
	} as unknown as ExtensionCommandContext & {
		readonly notify: ReturnType<typeof vi.fn>;
		readonly shutdown: ReturnType<typeof vi.fn>;
		readonly switchSession: ReturnType<typeof vi.fn>;
	};
}

describe("thread prompt metadata", () => {
	it("registers exactly one model-facing thread tool", () => {
		const tools = registeredThreadTools();

		expect(tools.map((tool) => tool.name)).toEqual(["thread"]);
	});

	it("uses only registry metadata with a neutral description", () => {
		const tool = registeredThreadTool();

		expect(tool.name).toBe("thread");
		expect(tool.label).toBe("Thread");
		expect(tool.description).toBe("Start and manage background Pi child sessions.");
		expect(tool.parameters).toBe(PiThreadParamsSchema);
		expect(tool).not.toHaveProperty("promptSnippet");
		expect(tool).not.toHaveProperty("promptGuidelines");
	});
});

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

describe("thread exit commands", () => {
	it("/exit outside a thread requests normal shutdown", async () => {
		const handlers = registeredCommandHandlers();
		const exit = handlers.get("exit");
		if (exit === undefined) throw new Error("/exit command was not registered");
		const commandContext = commandCtx();

		await exit("", commandContext);

		expect(commandContext.shutdown).toHaveBeenCalledTimes(1);
		expect(commandContext.switchSession).not.toHaveBeenCalled();
		expect(commandContext.notify).not.toHaveBeenCalled();
	});

	it("/exit inside an entered thread switches back to the recorded parent session", async () => {
		const handlers = registeredCommandHandlers();
		const exit = handlers.get("exit");
		if (exit === undefined) throw new Error("/exit command was not registered");
		const commandContext = commandCtx([
			{
				type: "custom_message",
				customType: PI_THREAD_ENTRY_MESSAGE_TYPE,
				details: { parentSessionFile: "/tmp/parent.jsonl" },
			},
		]);

		await exit("", commandContext);

		expect(commandContext.switchSession).toHaveBeenCalledWith("/tmp/parent.jsonl");
		expect(commandContext.shutdown).not.toHaveBeenCalled();
	});

	it("/threads exit warns when no parent session is recorded", async () => {
		const handlers = registeredCommandHandlers();
		const threads = handlers.get("threads");
		if (threads === undefined) throw new Error("/threads command was not registered");
		const commandContext = commandCtx();

		await threads("exit", commandContext);

		expect(commandContext.notify).toHaveBeenCalledWith(
			expect.stringContaining("No parent"),
			"warning",
		);
		expect(commandContext.shutdown).not.toHaveBeenCalled();
		expect(commandContext.switchSession).not.toHaveBeenCalled();
	});

	it("/threads exit inside an entered thread switches back to the recorded parent session", async () => {
		const handlers = registeredCommandHandlers();
		const threads = handlers.get("threads");
		if (threads === undefined) throw new Error("/threads command was not registered");
		const commandContext = commandCtx([
			{
				type: "custom_message",
				customType: PI_THREAD_ENTRY_MESSAGE_TYPE,
				details: { parentSessionFile: "/tmp/parent.jsonl" },
			},
		]);

		await threads("exit", commandContext);

		expect(commandContext.switchSession).toHaveBeenCalledWith("/tmp/parent.jsonl");
		expect(commandContext.shutdown).not.toHaveBeenCalled();
		expect(commandContext.notify).not.toHaveBeenCalled();
	});

	it("does not register the deprecated singular /thread command", () => {
		const handlers = registeredCommandHandlers();

		expect(handlers.has("thread")).toBe(false);
	});
});

describe("thread tool rendering", () => {
	it("does not list threads when rendering deterministic call labels", () => {
		let renderCall:
			| ((
					args: Record<string, unknown>,
					theme: Theme,
			  ) => {
					render: (width: number) => string[];
			  })
			| undefined;
		let listCalls = 0;
		const restoreManager = useProcessManager({
			list: () => {
				listCalls += 1;
				throw new Error("renderCall should not list threads for this action");
			},
		} as unknown as ThreadManager);
		const pi = {
			registerCommand: () => undefined,
			registerMessageRenderer: () => undefined,
			on: () => undefined,
			registerTool: (tool: { renderCall: typeof renderCall }) => {
				renderCall = tool.renderCall;
			},
		} as unknown as ExtensionAPI;

		try {
			extension(pi);
			if (renderCall === undefined) throw new Error("thread tool was not registered");

			expect(
				renderCall({ action: "start", prompt: "Draft a plan" }, theme)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe('thread start "Draft a plan"');
			expect(
				renderCall({ action: "list", state: "all" }, theme).render(80).join("\n").trimEnd(),
			).toBe("thread list");
			expect(
				renderCall({ action: "wait", timeoutMs: 1500 }, theme).render(80).join("\n").trimEnd(),
			).toBe("thread wait 1.5s");
			expect(
				renderCall({ action: "wait", id: "/root/review_tests", timeoutMs: 1500 }, theme)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe("thread wait /root/review_tests 1.5s");
			expect(
				renderCall({ action: "send", id: "review_tests", message: "Check failures" }, theme)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe('thread send review_tests "Check failures"');
			expect(listCalls).toBe(0);
		} finally {
			restoreManager();
		}
	});

	it("renders wait timeouts precisely instead of rounding fractional seconds", () => {
		let renderCall:
			| ((
					args: Record<string, unknown>,
					theme: Theme,
			  ) => {
					render: (width: number) => string[];
			  })
			| undefined;
		const pi = {
			registerCommand: () => undefined,
			registerMessageRenderer: () => undefined,
			on: () => undefined,
			registerTool: (tool: { renderCall: typeof renderCall }) => {
				renderCall = tool.renderCall;
			},
		} as unknown as ExtensionAPI;

		extension(pi);

		const rendered = renderCall?.(
			{ action: "wait", id: "/root/review_tests", timeoutMs: 1500 },
			theme,
		);

		expect(rendered?.render(80).join("\n")).toContain("1.5s");
		expect(rendered?.render(80).join("\n")).not.toContain("2s");
	});

	it("uses Pi's default result renderer to keep historical thread output plain", () => {
		let hasRenderResult: boolean | undefined;
		const pi = {
			registerCommand: () => undefined,
			registerMessageRenderer: () => undefined,
			on: () => undefined,
			registerTool: (tool: { renderResult?: unknown }) => {
				hasRenderResult = "renderResult" in tool;
			},
		} as unknown as ExtensionAPI;

		extension(pi);

		expect(hasRenderResult).toBe(false);
	});
});
