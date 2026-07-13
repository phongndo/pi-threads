import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendCustomEntryToSessionFile,
	materializeSessionManagerFile,
	safeGetLeafId,
	safeGetSessionFile,
	safeSessionBranch,
	safeSessionRegistryEntries,
} from "../src/pi-session-adapter.ts";
import { PI_THREAD_REGISTRY_ENTRY_TYPE } from "../src/thread-registry.ts";

describe("pi-session-adapter materialization", () => {
	it("falls back to manual file write when SessionManager has no _rewriteFile", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-materialize-fallback-"));
		try {
			const sessionFile = path.join(root, "sessions", "manual.jsonl");
			const header = {
				type: "session",
				id: "session-manual",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: root,
			};
			const entry = {
				type: "message",
				id: "msg_1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			// Intentionally omit `_rewriteFile` and `isPersisted` so the adapter
			// must use the manual materialization path.
			const stub: {
				getSessionFile: () => string;
				getHeader: () => typeof header;
				getEntries: () => readonly unknown[];
				flushed?: boolean;
			} = {
				getSessionFile: () => sessionFile,
				getHeader: () => header,
				getEntries: () => [entry],
			};

			expect(fs.existsSync(sessionFile)).toBe(false);
			materializeSessionManagerFile(stub);
			expect(fs.existsSync(sessionFile)).toBe(true);
			expect(stub.flushed).toBe(true);

			const lines = fs.readFileSync(sessionFile, "utf8").trimEnd().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0]!)).toEqual(header);
			expect(JSON.parse(lines[1]!)).toEqual(entry);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("is a no-op when the session file already exists", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-materialize-exists-"));
		try {
			const sessionFile = path.join(root, "already.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"session"}\n', "utf8");
			const stub = {
				getSessionFile: () => sessionFile,
				getHeader: () => {
					throw new Error("should not read header when file exists");
				},
				getEntries: () => {
					throw new Error("should not read entries when file exists");
				},
			};
			expect(() => materializeSessionManagerFile(stub)).not.toThrow();
			expect(fs.readFileSync(sessionFile, "utf8")).toBe('{"type":"session"}\n');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pi-session-adapter safe getters", () => {
	it("returns empty/undefined values when SessionManager methods throw", () => {
		const ctx = {
			sessionManager: {
				getSessionFile: () => {
					throw new Error("boom");
				},
				getBranch: () => {
					throw new Error("boom");
				},
				getEntries: () => {
					throw new Error("boom");
				},
				getLeafId: () => {
					throw new Error("boom");
				},
			},
		} as unknown as Parameters<typeof safeGetSessionFile>[0];

		expect(safeGetSessionFile(ctx)).toBeUndefined();
		expect(safeSessionBranch(ctx)).toEqual([]);
		expect(safeSessionRegistryEntries(ctx)).toEqual([]);
		expect(safeGetLeafId(ctx)).toBeNull();
	});

	it("prefers getEntries for registry restore and falls back to getBranch", () => {
		const entriesOnly = {
			sessionManager: {
				getEntries: () => [{ id: "from-entries" }],
				getBranch: () => [{ id: "from-branch" }],
			},
		} as unknown as Parameters<typeof safeSessionRegistryEntries>[0];
		expect(safeSessionRegistryEntries(entriesOnly)).toEqual([{ id: "from-entries" }]);

		const branchOnly = {
			sessionManager: {
				getBranch: () => [{ id: "from-branch" }],
			},
		} as unknown as Parameters<typeof safeSessionRegistryEntries>[0];
		expect(safeSessionRegistryEntries(branchOnly)).toEqual([{ id: "from-branch" }]);
	});
});

describe("pi-session-adapter appendCustomEntry", () => {
	it("appends a custom entry through SessionManager.open", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dispatch-append-custom-"));
		try {
			const sessionFile = path.join(root, "owner.jsonl");
			fs.writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "session",
					id: "session-owner",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: root,
				})}\n`,
				"utf8",
			);

			appendCustomEntryToSessionFile(sessionFile, root, PI_THREAD_REGISTRY_ENTRY_TYPE, {
				version: 1,
				kind: "thread_snapshot",
				snapshot: { id: "thread_test" },
			});

			const lines = fs.readFileSync(sessionFile, "utf8").trimEnd().split("\n");
			expect(lines.length).toBeGreaterThanOrEqual(2);
			expect(JSON.parse(lines.at(-1)!)).toMatchObject({
				type: "custom",
				customType: PI_THREAD_REGISTRY_ENTRY_TYPE,
				data: {
					version: 1,
					kind: "thread_snapshot",
					snapshot: { id: "thread_test" },
				},
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
