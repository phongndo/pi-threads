import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	asThreadId,
	asThreadPath,
	toThreadRuntimeSnapshot,
	type ThreadSnapshot,
} from "../src/domain.ts";
import extension from "../src/index.ts";
import { PiThreadParamsSchema } from "../src/schema.ts";
import {
	getThreadsSessionShutdownAction,
	prepareThreadsForSessionShutdown,
	shouldShutdownThreadsOnSessionShutdown,
	syncThreadManagerScope,
} from "../src/index.ts";
import { PI_THREAD_REGISTRY_ENTRY_TYPE, ThreadManager } from "../src/thread-manager.ts";

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
		archived: false,
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

function writeSessionHeader(file: string, id = "session-root", cwd = process.cwd()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
	);
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

describe("thread tool structured details", () => {
	it("returns normalized runtime snapshots for every action", async () => {
		const liveThread = threadSnapshot({
			state: "live",
			pid: 123,
			phase: "busy",
			lastPartialText: null,
			lastAssistantText: "Working on it",
		} as Partial<ThreadSnapshot>);
		const closedThread = threadSnapshot({
			state: "closed",
			exit: { kind: "exited", code: 0, signal: null },
			lastAssistantText: "Done",
		});
		const liveSnapshot = toThreadRuntimeSnapshot(liveThread);
		const closedSnapshot = toThreadRuntimeSnapshot(closedThread);
		const manager = {
			findBySessionFile: () => undefined,
			resetScope: () => undefined,
			start: async () => ({
				kind: "started" as const,
				promptAccepted: true,
				note: null,
				thread: liveThread,
				snapshot: liveSnapshot,
			}),
			list: () => [liveThread, closedThread],
			poll: async () => liveThread,
			send: async () => ({
				kind: "sent" as const,
				mode: "follow_up" as const,
				accepted: true,
				error: null,
				thread: liveThread,
				snapshot: liveSnapshot,
			}),
			wait: async (
				_command: unknown,
				options: { readonly onProgress?: (progress: unknown) => void },
			) => {
				options.onProgress?.({ waitedMs: 1, thread: liveThread, snapshot: liveSnapshot });
				return {
					kind: "waited" as const,
					timedOut: false,
					waitedMs: 5,
					thread: closedThread,
					snapshot: closedSnapshot,
				};
			},
			stop: async () => ({
				kind: "stopped" as const,
				alreadyClosed: false,
				thread: closedThread,
				snapshot: closedSnapshot,
			}),
			resume: async () => ({
				kind: "resumed" as const,
				alreadyLive: false,
				thread: liveThread,
				snapshot: liveSnapshot,
			}),
			fork: async () => ({
				kind: "forked" as const,
				sourceSessionFile: "/tmp/current.jsonl",
				sourceEntryId: null,
				thread: liveThread,
				snapshot: liveSnapshot,
			}),
			archive: () => ({
				kind: "archived" as const,
				archived: true,
				thread: closedThread,
				snapshot: closedSnapshot,
			}),
		} as unknown as ThreadManager;
		const restoreManager = useProcessManager(manager);

		try {
			const tool = registeredThreadTool();
			const context = ctx();
			const start = await tool.execute(
				"call-start",
				{ action: "start", prompt: "Inspect" },
				undefined,
				undefined,
				context,
			);
			const list = await tool.execute(
				"call-list",
				{ action: "list" },
				undefined,
				undefined,
				context,
			);
			const poll = await tool.execute(
				"call-poll",
				{ action: "poll", id: "alpha" },
				undefined,
				undefined,
				context,
			);
			const fullPoll = await tool.execute(
				"call-poll-full",
				{ action: "poll", id: "alpha", detail: "full" },
				undefined,
				undefined,
				context,
			);
			const send = await tool.execute(
				"call-send",
				{ action: "send", id: "alpha", message: "Continue", mode: "follow_up" },
				undefined,
				undefined,
				context,
			);
			const updates: unknown[] = [];
			const wait = await tool.execute(
				"call-wait",
				{ action: "wait", id: "alpha", timeoutMs: 0 },
				undefined,
				(update) => updates.push(update),
				context,
			);
			const tailUpdates: unknown[] = [];
			const tailWait = await tool.execute(
				"call-wait-tail",
				{ action: "wait", id: "alpha", detail: "tail", timeoutMs: 0 },
				undefined,
				(update) => tailUpdates.push(update),
				context,
			);
			const stop = await tool.execute(
				"call-stop",
				{ action: "stop", id: "alpha" },
				undefined,
				undefined,
				context,
			);
			const resume = await tool.execute(
				"call-resume",
				{ action: "resume", id: "alpha" },
				undefined,
				undefined,
				context,
			);
			const fork = await tool.execute(
				"call-fork",
				{ action: "fork" },
				undefined,
				undefined,
				context,
			);
			const archive = await tool.execute(
				"call-archive",
				{ action: "archive", id: "alpha" },
				undefined,
				undefined,
				context,
			);

			expect(start.details).toEqual(
				expect.objectContaining({
					kind: "started",
					running: true,
					nextSuggestedActions: ["wait", "poll", "send follow_up", "stop"],
					snapshot: expect.objectContaining({
						id: liveThread.id,
						path: liveThread.path,
						status: "live",
						phase: "busy",
						detail: "summary",
						resultSummary: "Working on it",
						recentEvents: expect.any(Array),
						nextSuggestedActions: ["wait", "poll", "send follow_up", "stop"],
					}),
					thread: expect.objectContaining({
						id: liveThread.id,
						detail: "summary",
						resultSummary: "Working on it",
					}),
				}),
			);
			expect(list.details).toEqual(
				expect.objectContaining({
					kind: "listed",
					count: 2,
					liveCount: 1,
					closedCount: 1,
					snapshots: [
						expect.objectContaining({ status: "live", phase: "busy" }),
						expect.objectContaining({ status: "closed", phase: "idle" }),
					],
				}),
			);
			for (const result of [poll, send, wait, stop, resume, fork, archive]) {
				expect(result.details).toEqual(
					expect.objectContaining({
						snapshot: expect.objectContaining({
							id: expect.any(String),
							path: expect.any(String),
							status: expect.stringMatching(/^(live|closed)$/u),
							detail: "summary",
							result: expect.objectContaining({ text: expect.any(String) }),
							recentEvents: expect.any(Array),
							nextSuggestedActions: expect.any(Array),
						}),
						nextSuggestedActions: expect.any(Array),
					}),
				);
			}
			expect(fullPoll.details).toEqual(
				expect.objectContaining({
					detail: "full",
					snapshot: expect.objectContaining({
						detail: "full",
						lastAssistantText: "Working on it",
					}),
				}),
			);
			expect(tailWait.details).toEqual(
				expect.objectContaining({
					detail: "tail",
					snapshot: expect.objectContaining({
						detail: "tail",
						outputTail: "Done",
					}),
				}),
			);
			expect(updates).toEqual([
				expect.objectContaining({
					details: expect.objectContaining({
						kind: "waiting",
						snapshot: expect.objectContaining({ status: "live", phase: "busy" }),
						nextSuggestedActions: ["wait", "poll", "send follow_up", "stop"],
					}),
				}),
			]);
			expect(tailUpdates).toEqual([
				expect.objectContaining({
					details: expect.objectContaining({
						kind: "waiting",
						detail: "tail",
						snapshot: expect.objectContaining({
							status: "live",
							phase: "busy",
							detail: "tail",
							outputTail: "Working on it",
						}),
					}),
				}),
			]);
		} finally {
			restoreManager();
		}
	});
});

describe("thread registry persistence", () => {
	it("writes non-current snapshots to their owning session file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-index-registry-"));
		try {
			const ownerSessionFile = path.join(root, "owner.jsonl");
			writeSessionHeader(ownerSessionFile, "session-root", root);
			let appendSnapshot:
				| ((
						snapshot: ThreadSnapshot,
						scope: { readonly sessionId: string } | null,
						target: {
							readonly sessionId: string | null;
							readonly sessionFile: string | null;
							readonly sessionDir: string | null;
							readonly isCurrentSession: boolean;
						} | null,
				  ) => void)
				| undefined;
			const restoreManager = useProcessManager({
				setPersistence: (persistence: { readonly appendSnapshot?: typeof appendSnapshot }) => {
					appendSnapshot = persistence.appendSnapshot;
				},
			} as unknown as ThreadManager);
			const appendEntry = vi.fn();
			const pi = {
				appendEntry,
				registerCommand: () => undefined,
				registerMessageRenderer: () => undefined,
				on: () => undefined,
				registerTool: () => undefined,
			} as unknown as ExtensionAPI;

			try {
				extension(pi);
				if (appendSnapshot === undefined) throw new Error("registry persistence was not set");

				appendSnapshot(
					threadSnapshot(),
					{ sessionId: "session-root" },
					{
						sessionId: "session-root",
						sessionFile: ownerSessionFile,
						sessionDir: root,
						isCurrentSession: false,
					},
				);
			} finally {
				restoreManager();
			}

			expect(appendEntry).not.toHaveBeenCalled();
			const entries = fs
				.readFileSync(ownerSessionFile, "utf8")
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(entries.at(-1)).toMatchObject({
				type: "custom",
				customType: PI_THREAD_REGISTRY_ENTRY_TYPE,
				data: {
					version: 1,
					kind: "thread_snapshot",
					scope: { sessionId: "session-root" },
					snapshot: { id: "thread_012345abcdef", path: "/root/alpha" },
				},
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("session shutdown thread lifecycle", () => {
	it("preserves thread management when switching into a closed managed child session", () => {
		expect(
			shouldShutdownThreadsOnSessionShutdown(
				event({ targetSessionFile: "/tmp/child.jsonl" }),
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
			getThreadsSessionShutdownAction(event({ targetSessionFile: "/tmp/child.jsonl" }), manager)
				.kind,
		).toBe("stop_target");
		expect(
			shouldShutdownThreadsOnSessionShutdown(
				event({ targetSessionFile: "/tmp/child.jsonl" }),
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

	it("rebinds the process manager for a managed child session", () => {
		const calls: string[] = [];
		const manager = {
			findBySessionFile: () => threadSnapshot(),
			rebindScope: (scope: unknown) => {
				calls.push(`rebind:${JSON.stringify(scope)}`);
			},
			resetScope: () => {
				calls.push("reset");
			},
			hydrateFromSession: () => {
				calls.push("hydrate");
			},
		} as unknown as ThreadManager;

		syncThreadManagerScope(ctx([], "/tmp/child.jsonl"), manager);

		expect(calls).toEqual([
			`rebind:${JSON.stringify({
				currentPath: "/root/alpha",
				depth: 1,
				selfThreadId: "thread_012345abcdef",
			})}`,
			"hydrate",
		]);
	});

	it("restores root sibling registry entries on the first sync after leaving a child scope", () => {
		const alpha = threadSnapshot({
			id: asThreadId("thread_aaaa1111aaaa"),
			name: "alpha",
			taskName: "alpha",
			path: asThreadPath("/root/alpha"),
			session: {
				kind: "known",
				file: "/tmp/alpha.jsonl",
				id: "session-alpha",
				name: null,
				pendingMessageCount: null,
			},
		});
		const beta = threadSnapshot({
			id: asThreadId("thread_bbbb2222bbbb"),
			name: "beta",
			taskName: "beta",
			path: asThreadPath("/root/beta"),
			session: {
				kind: "known",
				file: "/tmp/beta.jsonl",
				id: "session-beta",
				name: null,
				pendingMessageCount: null,
			},
		});
		const branch = [
			{
				type: "custom",
				customType: PI_THREAD_REGISTRY_ENTRY_TYPE,
				data: { version: 1, kind: "thread_snapshot", snapshot: alpha },
			},
			{
				type: "custom",
				customType: PI_THREAD_REGISTRY_ENTRY_TYPE,
				data: { version: 1, kind: "thread_snapshot", snapshot: beta },
			},
		];

		// Simulate the process-global manager retained by extension closures after a
		// child-session switch: still bound to the child path, then cleared on the way
		// back to root before the first list/sync of the root session.
		const manager = new ThreadManager({
			PI_DISPATCH_DEPTH: "0",
			PI_DISPATCH_MAX_DEPTH: "2",
			PI_DISPATCH_MAX_THREADS: "8",
			PI_DISPATCH_PATH: "/root",
			PI_DISPATCH_ROOT_SESSION_ID: "session-root",
		} as NodeJS.ProcessEnv);
		manager.rebindScope({
			currentPath: alpha.path,
			depth: alpha.depth,
			selfThreadId: alpha.id,
		});
		manager.clearThreads();

		syncThreadManagerScope(
			{
				ui: { notify: () => undefined },
				sessionManager: {
					getBranch: () => branch,
					getSessionFile: () => "/tmp/root.jsonl",
					getSessionId: () => "session-root",
				},
			} as unknown as ExtensionContext,
			manager,
		);

		expect(manager.getScope().currentPath).toBe("/root");
		expect(
			manager.list({ action: "list", visibility: "all" }).map((thread) => thread.path),
		).toEqual(["/root/alpha", "/root/beta"]);
	});

	it("still shuts down threads for quits and unrelated session resumes", () => {
		expect(
			shouldShutdownThreadsOnSessionShutdown(
				event({ reason: "quit" }),
				managerWithThread(threadSnapshot()),
			),
		).toBe(true);

		expect(
			shouldShutdownThreadsOnSessionShutdown(
				event({ targetSessionFile: "/tmp/other.jsonl" }),
				managerWithThread(threadSnapshot()),
			),
		).toBe(true);
	});
});

describe("thread commands", () => {
	it("registers only the observability browser as a user-facing thread command", () => {
		const handlers = registeredCommandHandlers();

		expect(handlers.has("threads")).toBe(true);
		for (const name of [
			"thread",
			"thread_start",
			"thread_poll",
			"thread_wait",
			"thread_send",
			"thread_stop",
			"thread_resume",
			"thread_fork",
			"thread_archive",
		]) {
			expect(handlers.has(name)).toBe(false);
		}
		expect(handlers.has("exit")).toBe(false);
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
				renderCall(
					{ action: "start", name: "Review docs", prompt: "Verbose implementation prompt" },
					theme,
				)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe('thread start "Review docs"');
			expect(
				renderCall({ action: "list", state: "all" }, theme).render(80).join("\n").trimEnd(),
			).toBe("thread list");
			expect(
				renderCall({ action: "wait", timeoutMs: 1500 }, theme).render(80).join("\n").trimEnd(),
			).toBe("thread wait");
			expect(
				renderCall({ action: "wait", id: "/root/review_tests", timeoutMs: 1500 }, theme)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe("thread wait review_tests");
			expect(
				renderCall(
					{ action: "send", id: "review_tests", mode: "follow_up", message: "Check failures" },
					theme,
				)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe("thread send review_tests");
			expect(
				renderCall(
					{
						action: "send",
						id: "thread_cleanup_job",
						mode: "follow_up",
						message: "Check failures",
					},
					theme,
				)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe("thread send thread_cleanup_job");
			expect(
				renderCall(
					{
						action: "fork",
						id: "/root/review_tests",
						entryId: "abc12345",
						taskName: "forked_review",
					},
					theme,
				)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe("thread fork review_tests");
			expect(
				renderCall({ action: "stop", id: "/root/review_tests", force: true }, theme)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe("thread stop review_tests force");
			expect(
				renderCall({ action: "archive", id: "/root/review_tests", archived: false }, theme)
					.render(80)
					.join("\n")
					.trimEnd(),
			).toBe("thread unarchive review_tests");
			expect(listCalls).toBe(0);
		} finally {
			restoreManager();
		}
	});

	it("keeps wait call labels quiet by hiding timeout and detail knobs", () => {
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
			{ action: "wait", id: "/root/review_tests", detail: "full", timeoutMs: 1500 },
			theme,
		);

		expect(rendered?.render(80).join("\n").trimEnd()).toBe("thread wait review_tests");
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
