import { describe, expect, it } from "vitest";
import {
	asThreadId,
	asThreadPath,
	nextSuggestedThreadActions,
	toThreadRuntimeSnapshot,
	type ClosedThreadSnapshot,
	type LiveThreadSnapshot,
	type ThreadSnapshot,
} from "../src/domain.ts";
import {
	formatPoll,
	formatThreadStateText,
	formatThreadTitle,
	formatWait,
	formatWaitProgress,
} from "../src/format.ts";

function liveThread(overrides: Partial<LiveThreadSnapshot> = {}): ThreadSnapshot {
	return {
		state: "live",
		id: asThreadId("thread_012345abcdef"),
		name: "inspect_repo",
		taskName: "inspect_repo",
		path: asThreadPath("/root/inspect_repo"),
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
		name: "inspect_repo",
		taskName: "inspect_repo",
		path: asThreadPath("/root/inspect_repo"),
		parentPath: asThreadPath("/root"),
		parentThreadId: null,
		depth: 1,
		archived: false,
		cwd: "/tmp/project",
		args: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		lastEventAt: "2026-01-01T00:00:00.000Z",
		exit: { kind: "exited", code: 0, signal: null },
		session: { kind: "unknown" },
		lastAssistantText: null,
		recentEvents: [],
		stderrTail: "",
		...overrides,
	};
}

describe("thread display formatting", () => {
	it("prefers generated session names for display titles", () => {
		const thread = liveThread({
			session: {
				kind: "known",
				file: "/tmp/session.jsonl",
				id: "session-1",
				name: "Review failing tests",
				pendingMessageCount: null,
			},
		});

		expect(formatThreadTitle(thread)).toBe("Review failing tests");
	});

	it("falls back to humanized task names instead of opaque ids", () => {
		const thread = liveThread({
			id: asThreadId("thread_111111111111"),
			name: "thread_111111111111",
			taskName: "review_tests",
			path: asThreadPath("/root/review_tests"),
		});

		expect(formatThreadTitle(thread)).toBe("review tests");
	});

	it("renders one canonical state text for live and closed threads", () => {
		expect(formatThreadStateText(liveThread({ phase: "busy" }))).toBe("live/busy");
		expect(formatThreadStateText(closedThread())).toBe("closed/exited");
		expect(
			formatThreadStateText(closedThread({ exit: { kind: "stale", message: "restored" } })),
		).toBe("closed/stale");
		expect(formatThreadStateText(closedThread({ exit: { kind: "failed", message: "boom" } }))).toBe(
			"closed/failed",
		);
	});

	it("shows running state and next actions in poll output", () => {
		const output = formatPoll(liveThread({ phase: "busy" }));

		expect(output).toContain("Running: yes");
		expect(output).toContain("Detail: summary");
		expect(output).toContain("Next: wait, poll, send follow_up, or stop");
		expect(nextSuggestedThreadActions(liveThread({ phase: "busy" }))).toEqual([
			"wait",
			"poll",
			"send follow_up",
			"stop",
		]);
	});

	it("keeps default poll details summarized and makes full output explicit", () => {
		const longText = `FIRST\n${"x".repeat(5_000)}\nLAST`;
		const thread = closedThread({ lastAssistantText: longText });

		const summarySnapshot = toThreadRuntimeSnapshot(thread);
		expect(summarySnapshot.detail).toBe("summary");
		expect(summarySnapshot.resultSummary).toContain("FIRST");
		expect(summarySnapshot.result.truncated).toBe(true);
		expect(summarySnapshot).not.toHaveProperty("lastAssistantText");
		expect(summarySnapshot).not.toHaveProperty("outputTail");

		const summaryOutput = formatPoll(thread);
		expect(summaryOutput).toContain("Result summary");
		expect(summaryOutput).toContain("truncated; use detail=tail or detail=full for more");
		expect(summaryOutput).not.toContain("LAST");

		const tailSnapshot = toThreadRuntimeSnapshot(thread, { detail: "tail" });
		expect(tailSnapshot.outputTail).toContain("LAST");
		expect(tailSnapshot.outputTruncated).toBe(true);
		expect(tailSnapshot).not.toHaveProperty("lastAssistantText");
		expect(formatPoll(thread, "tail")).toContain("Assistant output tail (truncated):");

		const fullSnapshot = toThreadRuntimeSnapshot(thread, { detail: "full" });
		expect(fullSnapshot.lastAssistantText).toBe(longText);
		expect(formatPoll(thread, "full")).toContain("Last assistant output (full retained):");
	});

	it("falls back to the last assistant output when a live partial is blank", () => {
		const thread = liveThread({
			lastAssistantText: "Previous answer",
			lastPartialText: " \n\t ",
		});

		const summarySnapshot = toThreadRuntimeSnapshot(thread);
		expect(summarySnapshot.result).toEqual(
			expect.objectContaining({
				status: "completed",
				source: "assistant_message",
				text: "Previous answer",
			}),
		);
		expect(summarySnapshot.resultSummary).toBe("Previous answer");

		const tailSnapshot = toThreadRuntimeSnapshot(thread, { detail: "tail" });
		expect(tailSnapshot.outputTail).toBe("Previous answer");
		expect(formatPoll(thread, "full")).toContain("Previous answer");
	});

	it("shows running state and next actions in wait output", () => {
		const idleOutput = formatWait({
			kind: "waited",
			timedOut: false,
			waitedMs: 12,
			...snapshotPair(liveThread({ phase: "idle" })),
		});
		const closedOutput = formatWaitProgress({ waitedMs: 12, ...snapshotPair(closedThread()) });

		expect(idleOutput).toContain("Running: yes");
		expect(idleOutput).toContain("Next: send prompt, poll, or stop");
		expect(closedOutput).toContain("Running: no");
		expect(closedOutput).toContain("Next: archive, or list");
	});
});

function snapshotPair(thread: ThreadSnapshot) {
	return { thread, snapshot: toThreadRuntimeSnapshot(thread) };
}
