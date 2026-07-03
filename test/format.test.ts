import { describe, expect, it } from "vitest";
import {
	asThreadId,
	asThreadPath,
	type LiveThreadSnapshot,
	type ThreadSnapshot,
} from "../src/domain.ts";
import { formatThreadLabel, formatThreadTitle } from "../src/format.ts";

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

	it("resolves labels from stable thread references", () => {
		const thread = liveThread();
		const threads = [thread];

		expect(formatThreadLabel(thread.id, threads)).toBe("inspect repo");
		expect(formatThreadLabel(thread.path, threads)).toBe("inspect repo");
		expect(formatThreadLabel("/root/review_tests", threads)).toBe("review tests");
	});
});
