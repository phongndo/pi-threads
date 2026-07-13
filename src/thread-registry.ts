import * as path from "node:path";
import {
	asThreadId,
	asThreadPath,
	assertTaskName,
	type ThreadPath,
	type ThreadSnapshot,
} from "./domain.ts";
import { isRecord, stringField } from "./json.ts";

// Durable registry entries append a full snapshot to the parent session file, so
// cap free-form texts there to keep a chatty child from ballooning that file.
const REGISTRY_TEXT_LIMIT = 20_000;

export const PI_THREAD_REGISTRY_ENTRY_TYPE = "pi-dispatch-registry";

export type ThreadRegistryEntryScope = {
	readonly sessionId: string;
};

export type ThreadRegistrySession = {
	readonly sessionId: string | null;
	readonly sessionFile: string | null;
	readonly sessionDir: string | null;
};

export type ThreadRegistryPersistenceTarget = ThreadRegistrySession & {
	readonly isCurrentSession: boolean;
};

export type ThreadRegistryPersistence = {
	readonly appendSnapshot?: (
		snapshot: ThreadSnapshot,
		scope: ThreadRegistryEntryScope | null,
		target: ThreadRegistryPersistenceTarget | null,
	) => void;
	/** Optional one-shot/throttled user-visible degraded signal (e.g. ctx.ui.notify). */
	readonly onPersistenceFailure?: (message: string) => void;
};

export type ThreadRegistryRestoreScope = {
	readonly sessionId: string | null;
	readonly sessionStartedAt: string | null;
	readonly currentPath: ThreadPath;
	readonly isRootSessionFork: boolean;
	readonly registrySession: ThreadRegistrySession | null;
	readonly registryGeneration: number;
};

export type DurableThreadData = {
	readonly version: 1;
	readonly kind: "thread_snapshot";
	readonly snapshot: ThreadSnapshot;
	readonly entryTimestamp: string | null;
	readonly scope?: ThreadRegistryEntryScope;
};

export function registryScope(
	target: ThreadRegistryPersistenceTarget,
): ThreadRegistryEntryScope | null {
	return target.sessionId === null ? null : { sessionId: target.sessionId };
}

export function truncateSnapshotForRegistry(threadSnapshot: ThreadSnapshot): ThreadSnapshot {
	const lastAssistantText = truncateRegistryText(threadSnapshot.lastAssistantText);
	if (threadSnapshot.state === "live") {
		return {
			...threadSnapshot,
			lastAssistantText,
			lastPartialText: truncateRegistryText(threadSnapshot.lastPartialText),
		};
	}
	return { ...threadSnapshot, lastAssistantText };
}

export function threadRegistrySessionsMatch(
	left: ThreadRegistrySession | null,
	right: ThreadRegistrySession | null,
): boolean {
	if (left === null || right === null) return left === right;
	if (left.sessionId !== null && right.sessionId !== null)
		return left.sessionId === right.sessionId;
	if (left.sessionFile !== null && right.sessionFile !== null) {
		return path.resolve(left.sessionFile) === path.resolve(right.sessionFile);
	}
	return (
		left.sessionId === right.sessionId &&
		left.sessionFile === right.sessionFile &&
		left.sessionDir === right.sessionDir
	);
}

export function registryTruncatedTextMatchesFull(
	truncatedText: string | null,
	fullText: string | null,
): boolean {
	if (truncatedText === null || fullText === null) return false;
	const match = /\n\[truncated ([1-9]\d*) chars for registry persistence\]$/u.exec(truncatedText);
	if (match === null) return false;

	const prefix = truncatedText.slice(0, match.index);
	const omittedLength = Number(match[1]);
	return (
		Number.isSafeInteger(omittedLength) &&
		fullText.length === prefix.length + omittedLength &&
		fullText.startsWith(prefix)
	);
}

export function restoreDurableThreadData(
	entries: readonly unknown[],
	scope: ThreadRegistryRestoreScope,
): readonly DurableThreadData[] {
	const latest = new Map<string, DurableThreadData>();
	for (const entry of entries) {
		const data = durableThreadDataFromEntry(entry);
		if (data === null) continue;
		if (!shouldRestoreDurableThread(data, scope)) continue;
		latest.set(data.snapshot.id, data);
	}

	return Array.from(latest.values());
}

export function restoredThreadRegistrySession(
	data: DurableThreadData,
	scope: ThreadRegistryRestoreScope,
): ThreadRegistrySession | null {
	if (scope.registrySession !== null) return scope.registrySession;
	if (data.scope === undefined) return null;
	return { sessionId: data.scope.sessionId, sessionFile: null, sessionDir: null };
}

function truncateRegistryText(text: string | null): string | null {
	if (text === null || text.length <= REGISTRY_TEXT_LIMIT) return text;
	return `${text.slice(0, REGISTRY_TEXT_LIMIT)}\n[truncated ${text.length - REGISTRY_TEXT_LIMIT} chars for registry persistence]`;
}

function shouldRestoreDurableThread(
	data: DurableThreadData,
	scope: ThreadRegistryRestoreScope,
): boolean {
	if (!threadSnapshotIsInCurrentScope(data.snapshot, scope.currentPath)) return false;
	if (data.scope !== undefined) {
		return scope.sessionId !== null && data.scope.sessionId === scope.sessionId;
	}

	if (!scope.isRootSessionFork) return true;

	// Legacy registry entries predate per-session ownership metadata. A root-level
	// fork has the same /root path, so keep only legacy entries appended after the
	// fork session header and drop copied source-session registry entries.
	return (
		data.entryTimestamp !== null &&
		scope.sessionStartedAt !== null &&
		data.entryTimestamp >= scope.sessionStartedAt
	);
}

function threadSnapshotIsInCurrentScope(
	threadSnapshot: ThreadSnapshot,
	currentPath: ThreadPath,
): boolean {
	return threadSnapshot.path.startsWith(`${currentPath}/`);
}

function durableThreadDataFromEntry(entry: unknown): DurableThreadData | null {
	if (!isRecord(entry) || entry["type"] !== "custom") return null;
	if (entry["customType"] !== PI_THREAD_REGISTRY_ENTRY_TYPE) return null;
	const data = entry["data"];
	if (!isRecord(data) || data["version"] !== 1 || data["kind"] !== "thread_snapshot") return null;
	const rawSnapshot = data["snapshot"];
	if (!isThreadSnapshotLike(rawSnapshot)) return null;
	const scope = threadRegistryEntryScopeFromValue(data["scope"]);
	const entryTimestamp = stringField(entry, "timestamp");
	return {
		version: 1,
		kind: "thread_snapshot",
		snapshot: rawSnapshot,
		entryTimestamp,
		...(scope === undefined ? {} : { scope }),
	};
}

function threadRegistryEntryScopeFromValue(value: unknown): ThreadRegistryEntryScope | undefined {
	if (!isRecord(value)) return undefined;
	const sessionId = stringField(value, "sessionId");
	if (sessionId === null || sessionId.length === 0) return undefined;
	return { sessionId };
}

function isThreadSnapshotLike(value: unknown): value is ThreadSnapshot {
	if (!isRecord(value)) return false;
	try {
		asThreadId(stringField(value, "id") ?? "");
		asThreadPath(stringField(value, "path") ?? "");
		asThreadPath(stringField(value, "parentPath") ?? "");
		assertTaskName(stringField(value, "taskName") ?? "");
		const parentThreadId = value["parentThreadId"];
		if (parentThreadId !== null)
			asThreadId(typeof parentThreadId === "string" ? parentThreadId : "");
		return (
			isSnapshotStateShape(value) &&
			typeof value["name"] === "string" &&
			typeof value["cwd"] === "string" &&
			typeof value["createdAt"] === "string" &&
			typeof value["lastEventAt"] === "string" &&
			typeof value["depth"] === "number" &&
			typeof value["archived"] === "boolean" &&
			(value["lastAssistantText"] === null || typeof value["lastAssistantText"] === "string") &&
			typeof value["stderrTail"] === "string" &&
			Array.isArray(value["args"]) &&
			value["args"].every((arg) => typeof arg === "string") &&
			Array.isArray(value["recentEvents"]) &&
			value["recentEvents"].every(isThreadEventLike) &&
			isThreadSessionLike(value["session"])
		);
	} catch {
		return false;
	}
}

function isSnapshotStateShape(value: Record<string, unknown>): boolean {
	if (value["state"] === "live") {
		return (
			typeof value["pid"] === "number" &&
			isThreadPhase(value["phase"]) &&
			(value["lastPartialText"] === null || typeof value["lastPartialText"] === "string")
		);
	}

	return value["state"] === "closed" && isThreadExitLike(value["exit"]);
}

function isThreadPhase(value: unknown): boolean {
	return value === "starting" || value === "busy" || value === "idle" || value === "stopping";
}

function isThreadSessionLike(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value["kind"] === "unknown") return true;
	return (
		value["kind"] === "known" &&
		typeof value["file"] === "string" &&
		typeof value["id"] === "string" &&
		(value["name"] === null || typeof value["name"] === "string") &&
		(value["pendingMessageCount"] === null || typeof value["pendingMessageCount"] === "number")
	);
}

function isThreadExitLike(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value["kind"] === "exited" || value["kind"] === "stopped") {
		return (
			(value["code"] === null || typeof value["code"] === "number") &&
			(value["signal"] === null || typeof value["signal"] === "string")
		);
	}

	return (
		(value["kind"] === "stale" || value["kind"] === "failed") &&
		typeof value["message"] === "string"
	);
}

function isThreadEventLike(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value["seq"] === "number" &&
		typeof value["at"] === "string" &&
		typeof value["type"] === "string"
	);
}
