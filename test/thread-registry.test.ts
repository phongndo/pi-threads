import { describe, expect, it } from "vitest";
import { asThreadId, asThreadPath, type ThreadSnapshot } from "../src/domain.ts";
import {
	PI_THREAD_REGISTRY_ENTRY_TYPE,
	registryTruncatedTextMatchesFull,
	restoreDurableThreadData,
	restoredThreadRegistrySession,
	threadRegistrySessionsMatch,
	truncateSnapshotForRegistry,
	type ThreadRegistryRestoreScope,
} from "../src/thread-registry.ts";

function snapshot(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
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
		lastEventAt: "2026-01-01T00:00:01.000Z",
		exit: { kind: "stale", message: "restored" },
		session: { kind: "unknown" },
		lastAssistantText: null,
		recentEvents: [],
		stderrTail: "",
		...overrides,
	} as ThreadSnapshot;
}

function registryEntry(
	threadSnapshot: ThreadSnapshot,
	options: {
		readonly timestamp?: string;
		readonly scope?: { readonly sessionId: string };
	} = {},
): unknown {
	return {
		type: "custom",
		customType: PI_THREAD_REGISTRY_ENTRY_TYPE,
		...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
		data: {
			version: 1,
			kind: "thread_snapshot",
			snapshot: threadSnapshot,
			...(options.scope === undefined ? {} : { scope: options.scope }),
		},
	};
}

function restoreScope(
	overrides: Partial<ThreadRegistryRestoreScope> = {},
): ThreadRegistryRestoreScope {
	return {
		sessionId: "session-current",
		sessionStartedAt: "2026-01-01T00:00:00.000Z",
		currentPath: asThreadPath("/root"),
		isRootSessionFork: false,
		registrySession: null,
		registryGeneration: 1,
		...overrides,
	};
}

describe("thread registry helpers", () => {
	it("truncates retained registry text without changing other snapshot fields", () => {
		const longText = "x".repeat(20_010);
		const live = snapshot({
			state: "live",
			pid: 123,
			phase: "busy",
			lastAssistantText: longText,
			lastPartialText: `${longText}partial`,
		});

		const truncated = truncateSnapshotForRegistry(live);

		expect(truncated).toMatchObject({ id: live.id, path: live.path, state: "live" });
		expect(truncated.lastAssistantText).toContain("[truncated 10 chars for registry persistence]");
		if (truncated.state !== "live") throw new Error("expected live snapshot");
		expect(truncated.lastPartialText).toContain("[truncated 17 chars for registry persistence]");
	});

	it("matches registry-truncated text only against the exact retained full text", () => {
		const full = `${"a".repeat(20_000)}0123456789`;
		const truncated = truncateSnapshotForRegistry(snapshot({ lastAssistantText: full }));

		expect(registryTruncatedTextMatchesFull(truncated.lastAssistantText, full)).toBe(true);
		expect(registryTruncatedTextMatchesFull(truncated.lastAssistantText, `${full}!`)).toBe(false);
		expect(registryTruncatedTextMatchesFull("not a truncation marker", full)).toBe(false);
	});

	it("preserves registry session matching semantics", () => {
		expect(threadRegistrySessionsMatch(null, null)).toBe(true);
		expect(
			threadRegistrySessionsMatch(null, { sessionId: null, sessionFile: null, sessionDir: null }),
		).toBe(false);
		expect(
			threadRegistrySessionsMatch(
				{ sessionId: "same", sessionFile: "/a", sessionDir: "/sessions" },
				{ sessionId: "same", sessionFile: "/b", sessionDir: "/other" },
			),
		).toBe(true);
		expect(
			threadRegistrySessionsMatch(
				{ sessionId: null, sessionFile: "/tmp/../tmp/session.jsonl", sessionDir: null },
				{ sessionId: null, sessionFile: "/tmp/session.jsonl", sessionDir: "/sessions" },
			),
		).toBe(true);
	});

	it("restores only latest matching durable registry data", () => {
		const first = snapshot({
			name: "first",
			path: asThreadPath("/root/scope/alpha"),
			parentPath: asThreadPath("/root/scope"),
		});
		const latest = snapshot({
			name: "latest",
			path: asThreadPath("/root/scope/alpha"),
			parentPath: asThreadPath("/root/scope"),
			lastEventAt: "2026-01-01T00:00:02.000Z",
		});
		const scopedOther = snapshot({
			id: asThreadId("thread_111111111111"),
			taskName: "other",
			path: asThreadPath("/root/scope/other"),
			parentPath: asThreadPath("/root/scope"),
		});
		const outside = snapshot({
			id: asThreadId("thread_222222222222"),
			taskName: "outside",
			path: asThreadPath("/root/outside"),
			parentPath: asThreadPath("/root"),
		});

		const restored = restoreDurableThreadData(
			[
				{ type: "custom", customType: PI_THREAD_REGISTRY_ENTRY_TYPE, data: { version: 2 } },
				registryEntry(first),
				registryEntry(scopedOther, { scope: { sessionId: "different-session" } }),
				registryEntry(outside),
				registryEntry(latest),
			],
			restoreScope({ currentPath: asThreadPath("/root/scope") }),
		);

		expect(restored.map((data) => data.snapshot.name)).toEqual(["latest"]);
	});

	it("ignores corrupt durable snapshots before hydration", () => {
		const corruptSnapshot = { ...snapshot(), args: ["--model", 42] };

		expect(
			restoreDurableThreadData([registryEntry(corruptSnapshot as never)], restoreScope()),
		).toEqual([]);
	});

	it("filters copied legacy root-fork entries by timestamp", () => {
		const beforeFork = snapshot({ name: "before" });
		const afterFork = snapshot({
			id: asThreadId("thread_111111111111"),
			name: "after",
			taskName: "after",
			path: asThreadPath("/root/after"),
		});

		const restored = restoreDurableThreadData(
			[
				registryEntry(beforeFork, { timestamp: "2025-12-31T23:59:59.000Z" }),
				registryEntry(afterFork, { timestamp: "2026-01-01T00:00:00.000Z" }),
			],
			restoreScope({ isRootSessionFork: true }),
		);

		expect(restored.map((data) => data.snapshot.name)).toEqual(["after"]);
	});

	it("reconstructs restored registry sessions from current or scoped metadata", () => {
		const data = restoreDurableThreadData(
			[registryEntry(snapshot(), { scope: { sessionId: "owned-session" } })],
			restoreScope({ sessionId: "owned-session" }),
		)[0]!;

		expect(
			restoredThreadRegistrySession(
				data,
				restoreScope({
					registrySession: { sessionId: "current", sessionFile: null, sessionDir: null },
				}),
			),
		).toEqual({ sessionId: "current", sessionFile: null, sessionDir: null });
		expect(restoredThreadRegistrySession(data, restoreScope({ registrySession: null }))).toEqual({
			sessionId: "owned-session",
			sessionFile: null,
			sessionDir: null,
		});
	});
});
