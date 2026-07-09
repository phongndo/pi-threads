import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KnownThreadSession, ThreadPath, ThreadSession } from "./domain.ts";
import { numberField, stringField } from "./json.ts";
import {
	materializeSessionManagerFile,
	safeGetSessionDir,
	safeGetSessionFile,
	safeGetSessionId,
} from "./pi-session-adapter.ts";
import type { ForkCommand } from "./schema.ts";
import {
	registryTruncatedTextMatchesFull,
	restoreDurableThreadData,
	restoredThreadRegistrySession,
	threadRegistrySessionsMatch,
	type DurableThreadData,
	type ThreadRegistryRestoreScope,
	type ThreadRegistrySession,
} from "./thread-registry.ts";
import {
	appendThreadEventAt,
	snapshot,
	type ClosedThread,
	type LiveThread,
	type ManagedThread,
} from "./thread-state.ts";

export type HydrationCacheKey = {
	readonly currentPath: ThreadPath;
	readonly sessionId: string | null;
	readonly sessionFile: string | null;
	readonly registryGeneration: number;
	readonly sessionStartedAt: string | null;
	readonly isRootSessionFork: boolean;
	readonly entryCount: number;
	readonly leafId: string | null;
};

export type ForkSource = {
	readonly sessionFile: string;
	readonly sessionDir: string | undefined;
	readonly cwd: string;
	readonly displayName: string;
};

export type ForkedManagedSession = {
	readonly cwd: string;
	readonly session: KnownThreadSession;
	readonly sourceEntryId: string | null;
};

export function hydrationCacheKeysMatch(
	left: HydrationCacheKey | null,
	right: HydrationCacheKey,
): boolean {
	if (left === null) return false;
	return (
		left.currentPath === right.currentPath &&
		left.sessionId === right.sessionId &&
		sameOptionalSessionFile(left.sessionFile, right.sessionFile) &&
		left.registryGeneration === right.registryGeneration &&
		left.sessionStartedAt === right.sessionStartedAt &&
		left.isRootSessionFork === right.isRootSessionFork &&
		left.entryCount === right.entryCount &&
		left.leafId === right.leafId
	);
}

function sameOptionalSessionFile(left: string | null, right: string | null): boolean {
	if (left === null || right === null) return left === right;
	return path.resolve(left) === path.resolve(right);
}

export function restoreDurableThreads(
	entries: readonly unknown[],
	scope: ThreadRegistryRestoreScope,
): readonly ClosedThread[] {
	return restoreDurableThreadData(entries, scope).map((data) =>
		snapshotToRestoredThread(data, scope),
	);
}

export function threadSnapshotsMatch(left: ManagedThread, right: ManagedThread): boolean {
	// Cheap scalar checks reject obvious mismatches before full JSON stringify.
	if (
		left.id !== right.id ||
		left.state !== right.state ||
		left.name !== right.name ||
		left.taskName !== right.taskName ||
		left.path !== right.path ||
		left.parentPath !== right.parentPath ||
		left.parentThreadId !== right.parentThreadId ||
		left.depth !== right.depth ||
		left.archived !== right.archived ||
		left.cwd !== right.cwd ||
		left.createdAt !== right.createdAt ||
		left.lastEventAt !== right.lastEventAt ||
		left.lastAssistantText !== right.lastAssistantText ||
		left.stderrTail !== right.stderrTail ||
		left.args.length !== right.args.length ||
		left.recentEvents.length !== right.recentEvents.length ||
		left.session.kind !== right.session.kind
	) {
		return false;
	}
	if (left.state === "closed" && right.state === "closed") {
		if (left.exit.kind !== right.exit.kind) return false;
	}
	if (left.state === "live" && right.state === "live") {
		if (left.pid !== right.pid || left.phase !== right.phase) return false;
		if (left.lastPartialText !== right.lastPartialText) return false;
	}
	return JSON.stringify(snapshot(left)) === JSON.stringify(snapshot(right));
}

export function preserveRegistryTruncatedText(
	existing: ClosedThread,
	restored: ClosedThread,
): ClosedThread {
	if (!registryTruncatedTextMatchesFull(restored.lastAssistantText, existing.lastAssistantText)) {
		return restored;
	}

	return { ...restored, lastAssistantText: existing.lastAssistantText };
}

export function withThreadRegistryMetadata(
	thread: ClosedThread,
	restored: ClosedThread,
): ClosedThread {
	return {
		...thread,
		registrySession: restored.registrySession,
		registryGeneration: restored.registryGeneration,
	};
}

export function threadRegistryMetadataMatches(left: ManagedThread, right: ManagedThread): boolean {
	return (
		left.registryGeneration === right.registryGeneration &&
		threadRegistrySessionsMatch(left.registrySession, right.registrySession)
	);
}

export function snapshotToRestoredThread(
	data: DurableThreadData,
	scope: ThreadRegistryRestoreScope,
): ClosedThread {
	const restored = data.snapshot;
	const recentEvents = [...restored.recentEvents];
	const nextEventSeq = Math.max(0, ...recentEvents.map((event) => event.seq)) + 1;
	const exit =
		restored.state === "closed"
			? restored.exit
			: {
					kind: "stale" as const,
					message:
						"Thread was restored from the parent Pi session registry without a live process connection.",
				};

	const thread: ClosedThread = {
		state: "closed",
		id: restored.id,
		name: restored.name,
		taskName: restored.taskName,
		path: restored.path,
		parentPath: restored.parentPath,
		parentThreadId: restored.parentThreadId,
		depth: restored.depth,
		registrySession: restoredThreadRegistrySession(data, scope),
		registryGeneration: scope.registryGeneration,
		archived: restored.archived === true,
		cwd: restored.cwd,
		args: [...restored.args],
		createdAt: restored.createdAt,
		lastEventAt: restored.lastEventAt,
		session: restored.session,
		lastAssistantText: restored.lastAssistantText,
		recentEvents,
		nextEventSeq,
		stderrTail: restored.stderrTail,
		exit,
	};

	if (restored.state === "live") {
		appendThreadEventAt(
			thread,
			{ type: "thread_closed", exit },
			data.entryTimestamp ?? restored.lastEventAt,
		);
	}
	return thread;
}

export function captureSession(thread: LiveThread, data: Record<string, unknown>): boolean {
	const file = stringField(data, "sessionFile");
	const id = stringField(data, "sessionId");
	if (file !== null && id !== null) {
		const nextSession = {
			kind: "known",
			file,
			id,
			name: stringField(data, "sessionName"),
			pendingMessageCount: numberField(data, "pendingMessageCount"),
		} satisfies ThreadSession;

		// pendingMessageCount is volatile queue state; only identity/name is durable.
		const durableChanged =
			thread.session.kind !== "known" ||
			thread.session.file !== nextSession.file ||
			thread.session.id !== nextSession.id ||
			thread.session.name !== nextSession.name;
		thread.session = nextSession;
		return durableChanged;
	}

	return false;
}

export function threadRegistrySessionFromContext(
	ctx: Pick<ExtensionContext, "sessionManager">,
): ThreadRegistrySession | null {
	const sessionId = safeGetSessionId(ctx);
	const sessionFile = safeGetSessionFile(ctx) ?? null;
	const sessionDir = safeGetSessionDir(ctx) ?? null;
	if (sessionId === null && sessionFile === null && sessionDir === null) return null;
	return { sessionId, sessionFile, sessionDir };
}

export function prepareManagedChildSession(
	ctx: ExtensionContext,
	cwd: string,
): { readonly session: KnownThreadSession } | null {
	const parentSessionFile = safeGetSessionFile(ctx);
	if (parentSessionFile === undefined) return null;

	const sessionManager = SessionManager.create(cwd, safeGetSessionDir(ctx), {
		parentSession: parentSessionFile,
	});
	materializeSessionManagerFile(sessionManager);
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile === undefined) return null;

	return {
		session: {
			kind: "known",
			file: sessionFile,
			id: sessionManager.getSessionId(),
			name: sessionManager.getSessionName() ?? null,
			pendingMessageCount: null,
		},
	};
}

export function createForkedManagedSession(
	source: ForkSource,
	command: ForkCommand,
): ForkedManagedSession {
	const sourceManager = SessionManager.open(source.sessionFile, source.sessionDir);
	const position = command.position ?? "at";
	const requestedEntryId = command.entryId ?? sourceManager.getLeafId();
	let sourceEntryId: string | null = requestedEntryId ?? null;

	let forkManager: SessionManager;
	if (requestedEntryId === null) {
		forkManager = SessionManager.create(sourceManager.getCwd(), sourceManager.getSessionDir(), {
			parentSession: source.sessionFile,
		});
	} else {
		let targetLeafId: string | null = requestedEntryId;
		if (position === "before") {
			const selectedEntry = sourceManager.getEntry(requestedEntryId);
			if (selectedEntry === undefined)
				throw new Error(`Cannot fork: entry not found: ${requestedEntryId}`);
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error(
					`Cannot fork before entry ${requestedEntryId}: the selected entry is not a user message. Repair: use position "at" or choose a user message entry id.`,
				);
			}
			targetLeafId = selectedEntry.parentId;
		}

		if (targetLeafId === null) {
			forkManager = SessionManager.create(sourceManager.getCwd(), sourceManager.getSessionDir(), {
				parentSession: source.sessionFile,
			});
		} else {
			const forkedPath = sourceManager.createBranchedSession(targetLeafId);
			if (forkedPath === undefined)
				throw new Error("Cannot fork: source session is not persisted.");
			forkManager = sourceManager;
		}
	}

	materializeSessionManagerFile(forkManager);
	const file = forkManager.getSessionFile();
	if (file === undefined) throw new Error("Cannot fork: forked session has no session file.");

	return {
		cwd: forkManager.getCwd(),
		session: {
			kind: "known",
			file,
			id: forkManager.getSessionId(),
			name: forkManager.getSessionName() ?? null,
			pendingMessageCount: null,
		},
		sourceEntryId,
	};
}

export function assertSessionFileExists(sessionFile: string, action: "resume" | "fork"): void {
	if (fs.existsSync(sessionFile)) return;
	throw new Error(
		`Cannot ${action} managed thread: saved Pi session file does not exist: ${sessionFile}. Repair: choose a thread with an existing session file, or start/fork a new thread.`,
	);
}

export function sameSessionFile(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}
