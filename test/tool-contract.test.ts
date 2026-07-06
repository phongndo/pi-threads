import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	asThreadId,
	asThreadPath,
	toThreadRuntimeSnapshot,
	type ThreadSnapshot,
} from "../src/domain.ts";
import extension from "../src/index.ts";
import type { ThreadManager } from "../src/thread-manager.ts";

const PROCESS_MANAGER_KEY = "__piThreadsProcessManager";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

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

function registeredThreadTool(): RegisteredTool {
	let registered: RegisteredTool | undefined;
	const pi = {
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		on: () => undefined,
		registerTool: (tool: RegisteredTool) => {
			registered = tool;
		},
	} as unknown as ExtensionAPI;

	extension(pi);
	if (registered === undefined) throw new Error("thread tool was not registered");
	return registered;
}

function ctx(): ExtensionContext {
	return {
		ui: { notify: () => undefined },
		sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
}

function contractThread(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
	return {
		state: "live",
		id: asThreadId("thread_012345abcdef"),
		name: "contract child",
		taskName: "contract_child",
		path: asThreadPath("/root/contract_child"),
		parentPath: asThreadPath("/root"),
		parentThreadId: null,
		depth: 1,
		archived: false,
		cwd: "/tmp/project",
		args: ["--model", "sonnet"],
		createdAt: "2026-02-03T04:05:06.000Z",
		lastEventAt: "2026-02-03T04:05:09.000Z",
		session: {
			kind: "known",
			file: "/tmp/contract-child.jsonl",
			id: "session-child",
			name: "Contract child",
			pendingMessageCount: 0,
		},
		lastAssistantText: "Previous completed answer.",
		recentEvents: [
			{
				seq: 1,
				at: "2026-02-03T04:05:06.000Z",
				type: "thread_started",
				pid: 4242,
			},
			{ seq: 2, at: "2026-02-03T04:05:07.000Z", type: "turn_started" },
			{
				seq: 3,
				at: "2026-02-03T04:05:07.100Z",
				type: "tool_started",
				toolName: "read",
			},
			{
				seq: 4,
				at: "2026-02-03T04:05:07.200Z",
				type: "tool_completed",
				toolName: "read",
				error: true,
			},
			{
				seq: 5,
				at: "2026-02-03T04:05:08.000Z",
				type: "assistant_message",
				text: "Assistant event text with\nnewlines",
			},
			{
				seq: 6,
				at: "2026-02-03T04:05:09.000Z",
				type: "thread_error",
				message: "minor stderr noise",
			},
		],
		stderrTail: "stderr line",
		pid: 4242,
		phase: "busy",
		lastPartialText: "Partial answer\nwith extra spacing",
		...overrides,
	} as ThreadSnapshot;
}

function managerForToolContract(liveThread: ThreadSnapshot, closedThread: ThreadSnapshot) {
	return {
		findBySessionFile: () => undefined,
		resetScope: () => undefined,
		list: () => [liveThread, closedThread],
		send: async () => ({
			kind: "sent" as const,
			mode: "prompt" as const,
			accepted: false,
			error: "child is not accepting a prompt right now",
			thread: liveThread,
			snapshot: toThreadRuntimeSnapshot(liveThread),
		}),
		wait: async (
			_command: unknown,
			options: { readonly onProgress?: (progress: unknown) => void },
		) => {
			options.onProgress?.({
				waitedMs: 250,
				thread: liveThread,
				snapshot: toThreadRuntimeSnapshot(liveThread),
			});
			return {
				kind: "waited" as const,
				timedOut: true,
				waitedMs: 500,
				thread: liveThread,
				snapshot: toThreadRuntimeSnapshot(liveThread),
			};
		},
	} as unknown as ThreadManager;
}

function recordDetails(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected object details");
	}
	return value as Record<string, unknown>;
}

function singleDetailsContract(value: unknown, expectedSnapshot: unknown): Record<string, unknown> {
	const details = recordDetails(value);
	expect(details["thread"]).toBe(details["snapshot"]);
	expect(details["snapshot"]).toEqual(expectedSnapshot);
	const projected = { ...details };
	projected["snapshot"] = "<runtime snapshot>";
	delete projected["thread"];
	projected["thread"] = "<same object as snapshot>";
	return projected;
}

function listDetailsContract(
	value: unknown,
	expectedSnapshots: readonly unknown[],
): Record<string, unknown> {
	const details = recordDetails(value);
	expect(details["threads"]).toBe(details["snapshots"]);
	expect(details["snapshots"]).toEqual(expectedSnapshots);
	const projected = { ...details };
	projected["snapshots"] = `<${expectedSnapshots.length} runtime snapshots>`;
	delete projected["threads"];
	projected["threads"] = "<same array as snapshots>";
	return projected;
}

describe("thread contract snapshots", () => {
	it("keeps runtime snapshot detail levels stable", () => {
		const thread = contractThread();

		expect({
			summary: toThreadRuntimeSnapshot(thread),
			tail: toThreadRuntimeSnapshot(thread, { detail: "tail" }),
			full: toThreadRuntimeSnapshot(thread, { detail: "full" }),
		}).toMatchInlineSnapshot(`
			{
			  "full": {
			    "archived": false,
			    "args": [
			      "--model",
			      "sonnet",
			    ],
			    "createdAt": "2026-02-03T04:05:06.000Z",
			    "cwd": "/tmp/project",
			    "depth": 1,
			    "detail": "full",
			    "id": "thread_012345abcdef",
			    "lastAssistantText": "Previous completed answer.",
			    "lastEventAt": "2026-02-03T04:05:09.000Z",
			    "lastPartialText": "Partial answer
			with extra spacing",
			    "name": "contract child",
			    "nextSuggestedActions": [
			      "wait",
			      "poll",
			      "send follow_up",
			      "stop",
			    ],
			    "parentPath": "/root",
			    "parentThreadId": null,
			    "path": "/root/contract_child",
			    "phase": "busy",
			    "pid": 4242,
			    "recentEvents": [
			      {
			        "at": "2026-02-03T04:05:06.000Z",
			        "pid": 4242,
			        "seq": 1,
			        "type": "thread_started",
			      },
			      {
			        "at": "2026-02-03T04:05:07.000Z",
			        "seq": 2,
			        "type": "turn_started",
			      },
			      {
			        "at": "2026-02-03T04:05:07.100Z",
			        "seq": 3,
			        "toolName": "read",
			        "type": "tool_started",
			      },
			      {
			        "at": "2026-02-03T04:05:07.200Z",
			        "error": true,
			        "seq": 4,
			        "toolName": "read",
			        "type": "tool_completed",
			      },
			      {
			        "at": "2026-02-03T04:05:08.000Z",
			        "seq": 5,
			        "text": "Assistant event text with
			newlines",
			        "type": "assistant_message",
			      },
			      {
			        "at": "2026-02-03T04:05:09.000Z",
			        "message": "minor stderr noise",
			        "seq": 6,
			        "type": "thread_error",
			      },
			    ],
			    "result": {
			      "charCount": 33,
			      "source": "assistant_partial",
			      "status": "partial",
			      "text": "Partial answer with extra spacing",
			      "truncated": false,
			    },
			    "resultSummary": "Partial answer with extra spacing",
			    "resumable": false,
			    "running": true,
			    "session": {
			      "file": "/tmp/contract-child.jsonl",
			      "id": "session-child",
			      "kind": "known",
			      "name": "Contract child",
			      "pendingMessageCount": 0,
			    },
			    "stale": false,
			    "status": "live",
			    "stderrTail": "stderr line",
			    "stderrTruncated": false,
			    "taskName": "contract_child",
			  },
			  "summary": {
			    "archived": false,
			    "args": [
			      "--model",
			      "sonnet",
			    ],
			    "createdAt": "2026-02-03T04:05:06.000Z",
			    "cwd": "/tmp/project",
			    "depth": 1,
			    "detail": "summary",
			    "id": "thread_012345abcdef",
			    "lastEventAt": "2026-02-03T04:05:09.000Z",
			    "name": "contract child",
			    "nextSuggestedActions": [
			      "wait",
			      "poll",
			      "send follow_up",
			      "stop",
			    ],
			    "parentPath": "/root",
			    "parentThreadId": null,
			    "path": "/root/contract_child",
			    "phase": "busy",
			    "pid": 4242,
			    "recentEvents": [
			      {
			        "at": "2026-02-03T04:05:07.000Z",
			        "seq": 2,
			        "type": "turn_started",
			      },
			      {
			        "at": "2026-02-03T04:05:07.100Z",
			        "seq": 3,
			        "toolName": "read",
			        "type": "tool_started",
			      },
			      {
			        "at": "2026-02-03T04:05:07.200Z",
			        "error": true,
			        "seq": 4,
			        "toolName": "read",
			        "type": "tool_completed",
			      },
			      {
			        "at": "2026-02-03T04:05:08.000Z",
			        "seq": 5,
			        "text": "Assistant event text with newlines",
			        "type": "assistant_message",
			      },
			      {
			        "at": "2026-02-03T04:05:09.000Z",
			        "message": "minor stderr noise",
			        "seq": 6,
			        "type": "thread_error",
			      },
			    ],
			    "result": {
			      "charCount": 33,
			      "source": "assistant_partial",
			      "status": "partial",
			      "text": "Partial answer with extra spacing",
			      "truncated": false,
			    },
			    "resultSummary": "Partial answer with extra spacing",
			    "resumable": false,
			    "running": true,
			    "session": {
			      "file": "/tmp/contract-child.jsonl",
			      "id": "session-child",
			      "kind": "known",
			      "name": "Contract child",
			      "pendingMessageCount": 0,
			    },
			    "stale": false,
			    "status": "live",
			    "taskName": "contract_child",
			  },
			  "tail": {
			    "archived": false,
			    "args": [
			      "--model",
			      "sonnet",
			    ],
			    "createdAt": "2026-02-03T04:05:06.000Z",
			    "cwd": "/tmp/project",
			    "depth": 1,
			    "detail": "tail",
			    "id": "thread_012345abcdef",
			    "lastEventAt": "2026-02-03T04:05:09.000Z",
			    "name": "contract child",
			    "nextSuggestedActions": [
			      "wait",
			      "poll",
			      "send follow_up",
			      "stop",
			    ],
			    "outputCharCount": 33,
			    "outputTail": "Partial answer
			with extra spacing",
			    "outputTruncated": false,
			    "parentPath": "/root",
			    "parentThreadId": null,
			    "path": "/root/contract_child",
			    "phase": "busy",
			    "pid": 4242,
			    "recentEvents": [
			      {
			        "at": "2026-02-03T04:05:06.000Z",
			        "pid": 4242,
			        "seq": 1,
			        "type": "thread_started",
			      },
			      {
			        "at": "2026-02-03T04:05:07.000Z",
			        "seq": 2,
			        "type": "turn_started",
			      },
			      {
			        "at": "2026-02-03T04:05:07.100Z",
			        "seq": 3,
			        "toolName": "read",
			        "type": "tool_started",
			      },
			      {
			        "at": "2026-02-03T04:05:07.200Z",
			        "error": true,
			        "seq": 4,
			        "toolName": "read",
			        "type": "tool_completed",
			      },
			      {
			        "at": "2026-02-03T04:05:08.000Z",
			        "seq": 5,
			        "text": "Assistant event text with newlines",
			        "type": "assistant_message",
			      },
			      {
			        "at": "2026-02-03T04:05:09.000Z",
			        "message": "minor stderr noise",
			        "seq": 6,
			        "type": "thread_error",
			      },
			    ],
			    "result": {
			      "charCount": 33,
			      "source": "assistant_partial",
			      "status": "partial",
			      "text": "Partial answer with extra spacing",
			      "truncated": false,
			    },
			    "resultSummary": "Partial answer with extra spacing",
			    "resumable": false,
			    "running": true,
			    "session": {
			      "file": "/tmp/contract-child.jsonl",
			      "id": "session-child",
			      "kind": "known",
			      "name": "Contract child",
			      "pendingMessageCount": 0,
			    },
			    "stale": false,
			    "status": "live",
			    "stderrTail": "stderr line",
			    "stderrTruncated": false,
			    "taskName": "contract_child",
			  },
			}
		`);
	});

	it("keeps tool details stable for aggregate, progress, and recoverable send errors", async () => {
		const liveThread = contractThread();
		const closedThread = contractThread({
			state: "closed",
			lastAssistantText: "Completed final answer.",
			exit: { kind: "exited", code: 1, signal: null },
		} as Partial<ThreadSnapshot>);
		const restoreManager = useProcessManager(managerForToolContract(liveThread, closedThread));

		try {
			const tool = registeredThreadTool();
			const context = ctx();
			const updates: unknown[] = [];

			const list = await tool.execute(
				"call-list",
				{ action: "list" },
				undefined,
				undefined,
				context,
			);
			const send = await tool.execute(
				"call-send",
				{ action: "send", id: "/root/contract_child", message: "Next" },
				undefined,
				undefined,
				context,
			);
			const wait = await tool.execute(
				"call-wait",
				{ action: "wait", id: "/root/contract_child", timeoutMs: 0 },
				undefined,
				(update) => updates.push(update),
				context,
			);
			const liveSnapshot = toThreadRuntimeSnapshot(liveThread);
			const closedSnapshot = toThreadRuntimeSnapshot(closedThread);

			expect({
				list: listDetailsContract(list.details, [liveSnapshot, closedSnapshot]),
				send: singleDetailsContract(send.details, liveSnapshot),
				waitProgress: singleDetailsContract(
					(updates[0] as { readonly details?: unknown } | undefined)?.details,
					liveSnapshot,
				),
				wait: singleDetailsContract(wait.details, liveSnapshot),
			}).toMatchInlineSnapshot(`
				{
				  "list": {
				    "closedCount": 1,
				    "count": 2,
				    "detail": "summary",
				    "kind": "listed",
				    "liveCount": 1,
				    "snapshots": "<2 runtime snapshots>",
				    "threads": "<same array as snapshots>",
				  },
				  "send": {
				    "accepted": false,
				    "detail": "summary",
				    "error": "child is not accepting a prompt right now",
				    "kind": "sent",
				    "mode": "prompt",
				    "nextSuggestedActions": [
				      "wait",
				      "poll",
				      "send follow_up",
				      "stop",
				    ],
				    "running": true,
				    "snapshot": "<runtime snapshot>",
				    "thread": "<same object as snapshot>",
				  },
				  "wait": {
				    "detail": "summary",
				    "kind": "waited",
				    "nextSuggestedActions": [
				      "wait",
				      "poll",
				      "send follow_up",
				      "stop",
				    ],
				    "running": true,
				    "snapshot": "<runtime snapshot>",
				    "thread": "<same object as snapshot>",
				    "timedOut": true,
				    "waitedMs": 500,
				  },
				  "waitProgress": {
				    "detail": "summary",
				    "kind": "waiting",
				    "nextSuggestedActions": [
				      "wait",
				      "poll",
				      "send follow_up",
				      "stop",
				    ],
				    "running": true,
				    "snapshot": "<runtime snapshot>",
				    "thread": "<same object as snapshot>",
				    "waitedMs": 250,
				  },
				}
			`);
		} finally {
			restoreManager();
		}
	});

	it("keeps tool-thrown errors stable", async () => {
		const restoreManager = useProcessManager({
			findBySessionFile: () => undefined,
			resetScope: () => undefined,
			poll: async () => {
				throw new Error(
					'Unknown thread reference: "missing". Repair: use a known path/id, run { "action": "list" }, or start the thread first.',
				);
			},
		} as unknown as ThreadManager);

		try {
			const tool = registeredThreadTool();
			const context = ctx();
			const controller = new AbortController();
			controller.abort();

			await expect(
				tool.execute(
					"call-invalid",
					{ action: "send", id: "missing" },
					undefined,
					undefined,
					context,
				),
			).rejects.toThrowErrorMatchingInlineSnapshot(
				`[Error: Invalid thread parameters for send: missing required field message. Repair: use the send shape { "action": "send", "id": "/root/inspect_tests", "message": "Continue", "mode": "follow_up" }.]`,
			);
			await expect(
				tool.execute("call-abort", { action: "list" }, controller.signal, undefined, context),
			).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: Thread action aborted]`);
			await expect(
				tool.execute(
					"call-manager-error",
					{ action: "poll", id: "missing" },
					undefined,
					undefined,
					context,
				),
			).rejects.toThrowErrorMatchingInlineSnapshot(
				`[Error: Unknown thread reference: "missing". Repair: use a known path/id, run { "action": "list" }, or start the thread first.]`,
			);
		} finally {
			restoreManager();
		}
	});
});
