import { randomUUID } from "node:crypto";

declare const threadIdBrand: unique symbol;
declare const threadPathBrand: unique symbol;

export type ThreadId = string & { readonly [threadIdBrand]: "ThreadId" };
export type ThreadPath = string & { readonly [threadPathBrand]: "ThreadPath" };

export const ROOT_THREAD_PATH = asThreadPath("/root");

export type ThreadPhase = "starting" | "busy" | "idle" | "stopping";

export interface UnknownThreadSession {
	readonly kind: "unknown";
}

export interface KnownThreadSession {
	readonly kind: "known";
	readonly file: string;
	readonly id: string;
	readonly name: string | null;
	readonly pendingMessageCount: number | null;
}

export type ThreadSession = UnknownThreadSession | KnownThreadSession;

type ProcessThreadExit<K extends "exited" | "stopped"> = {
	readonly kind: K;
	readonly code: number | null;
	readonly signal: string | null;
};

type MessageThreadExit<K extends "stale" | "failed"> = {
	readonly kind: K;
	readonly message: string;
};

export type ThreadExit =
	| ProcessThreadExit<"exited">
	| ProcessThreadExit<"stopped">
	| MessageThreadExit<"stale">
	| MessageThreadExit<"failed">;

export type ThreadEvent =
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "thread_started";
			readonly pid: number;
	  }
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "thread_resumed";
			readonly pid: number;
	  }
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "thread_forked";
			readonly pid: number;
			readonly sourceSessionFile: string;
			readonly sourceEntryId: string | null;
	  }
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "thread_archived";
			readonly archived: boolean;
	  }
	| { readonly seq: number; readonly at: string; readonly type: "thread_stopping" }
	| { readonly seq: number; readonly at: string; readonly type: "turn_started" }
	| { readonly seq: number; readonly at: string; readonly type: "turn_completed" }
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "tool_started";
			readonly toolName: string;
	  }
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "tool_completed";
			readonly toolName: string;
			readonly error: boolean;
	  }
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "assistant_message";
			readonly text: string;
	  }
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "ui_request";
			readonly method: string;
			readonly title: string | null;
			readonly autoCancelled: boolean;
	  }
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "thread_closed";
			readonly exit: ThreadExit;
	  }
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "thread_error";
			readonly message: string;
	  };

export interface ThreadSnapshotBase {
	readonly id: ThreadId;
	readonly name: string;
	readonly taskName: string;
	readonly path: ThreadPath;
	readonly parentPath: ThreadPath;
	readonly parentThreadId: ThreadId | null;
	readonly depth: number;
	readonly archived: boolean;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createdAt: string;
	readonly lastEventAt: string;
	readonly session: ThreadSession;
	readonly lastAssistantText: string | null;
	readonly recentEvents: readonly ThreadEvent[];
	readonly stderrTail: string;
}

export interface LiveThreadSnapshot extends ThreadSnapshotBase {
	readonly state: "live";
	readonly pid: number;
	readonly phase: ThreadPhase;
	readonly lastPartialText: string | null;
}

export interface ClosedThreadSnapshot extends ThreadSnapshotBase {
	readonly state: "closed";
	readonly exit: ThreadExit;
}

export type ThreadSnapshot = LiveThreadSnapshot | ClosedThreadSnapshot;

export type ThreadRuntimeStatus = "live" | "closed";

export type ThreadRuntimePhase = ThreadPhase | "failed" | "stale";

export type ThreadDetail = "summary" | "tail" | "full";

export type ThreadResultStatus = "none" | "partial" | "completed";

export type ThreadResultSummary = {
	readonly status: ThreadResultStatus;
	readonly source: "none" | "assistant_message" | "assistant_partial";
	readonly text: string | null;
	readonly charCount: number;
	readonly truncated: boolean;
};

export const DEFAULT_THREAD_DETAIL: ThreadDetail = "summary";

export type ThreadRuntimeSnapshot = {
	readonly id: ThreadId;
	readonly path: ThreadPath;
	readonly name: string;
	readonly taskName: string;
	readonly status: ThreadRuntimeStatus;
	readonly phase: ThreadRuntimePhase;
	readonly running: boolean;
	readonly parentPath: ThreadPath;
	readonly parentThreadId: ThreadId | null;
	readonly depth: number;
	readonly archived: boolean;
	readonly resumable: boolean;
	readonly stale: boolean;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createdAt: string;
	readonly lastEventAt: string;
	readonly pid?: number;
	readonly exit?: ThreadExit;
	readonly session: ThreadSession;
	readonly detail: ThreadDetail;
	readonly result: ThreadResultSummary;
	readonly resultSummary?: string;
	readonly outputTail?: string;
	readonly outputCharCount?: number;
	readonly outputTruncated?: boolean;
	readonly stderrTail?: string;
	readonly stderrTruncated?: boolean;
	readonly lastAssistantText?: string;
	readonly lastPartialText?: string;
	readonly recentEvents: readonly ThreadEvent[];
	readonly nextSuggestedActions: readonly string[];
};

export function newThreadId(): ThreadId {
	return asThreadId(`thread_${randomUUID().replaceAll("-", "").slice(0, 12)}`);
}

export function asThreadId(value: string): ThreadId {
	if (!/^thread_[0-9a-f]{12}$/u.test(value)) {
		throw new Error(`Invalid thread id: ${value}`);
	}

	return value as ThreadId;
}

export function isThreadIdText(value: string): boolean {
	return /^thread_[0-9a-f]{12}$/u.test(value);
}

export function assertTaskName(value: string): string {
	if (!/^[a-z0-9][a-z0-9_]{0,63}$/u.test(value)) {
		throw new Error(`Invalid task name: ${value}. Use lowercase letters, digits, and underscores.`);
	}

	return value;
}

export function asThreadPath(value: string): ThreadPath {
	if (!/^\/root(?:\/[a-z0-9][a-z0-9_]{0,63})*$/u.test(value)) {
		throw new Error(`Invalid thread path: ${value}`);
	}

	return value as ThreadPath;
}

export function joinThreadPath(parent: ThreadPath, taskName: string): ThreadPath {
	return asThreadPath(`${parent}/${assertTaskName(taskName)}`);
}

export function threadPathBasename(threadPath: ThreadPath): string {
	return threadPath.slice(threadPath.lastIndexOf("/") + 1);
}

export function isThreadExitFailed(exit: ThreadExit): boolean {
	return (
		exit.kind === "failed" || (exit.kind === "exited" && (exit.code !== 0 || exit.signal !== null))
	);
}

export function isThreadRunning(thread: ThreadSnapshot): boolean {
	return thread.state === "live";
}

export function nextSuggestedThreadActions(thread: ThreadSnapshot): readonly string[] {
	if (thread.archived)
		return thread.state === "closed" ? ["unarchive", "list"] : ["unarchive", "poll"];
	if (thread.state === "closed") {
		return thread.session.kind === "known"
			? ["resume", "fork", "archive", "list"]
			: ["archive", "list"];
	}
	if (thread.phase === "idle") return ["send prompt", "poll", "stop"];
	if (thread.phase === "stopping") return ["poll", "wait"];
	return ["wait", "poll", "send follow_up", "stop"];
}

export function toThreadRuntimeSnapshot(
	thread: ThreadSnapshot,
	options: { readonly detail?: ThreadDetail } = {},
): ThreadRuntimeSnapshot {
	const detail = options.detail ?? DEFAULT_THREAD_DETAIL;
	const outputText = currentAssistantOutputText(thread);
	const result = summarizeThreadResult(thread, detail);
	const outputTail = detail === "tail" && outputText !== null ? tailText(outputText, 4_000) : null;
	const shouldIncludeStderrTail = detail !== "summary" && thread.stderrTail.trim() !== "";
	const stderrTail = shouldIncludeStderrTail
		? detail === "full"
			? { text: thread.stderrTail, truncated: false }
			: tailText(thread.stderrTail, 4_000)
		: null;
	const common = {
		id: thread.id,
		path: thread.path,
		name: thread.name,
		taskName: thread.taskName,
		status: thread.state,
		running: isThreadRunning(thread),
		parentPath: thread.parentPath,
		parentThreadId: thread.parentThreadId,
		depth: thread.depth,
		archived: thread.archived === true,
		resumable: thread.state === "closed" && thread.session.kind === "known",
		stale: thread.state === "closed" && thread.exit.kind === "stale",
		cwd: thread.cwd,
		args: [...thread.args],
		createdAt: thread.createdAt,
		lastEventAt: thread.lastEventAt,
		session: thread.session,
		detail,
		result,
		...(result.text === null ? {} : { resultSummary: result.text }),
		...(outputTail === null
			? {}
			: {
					outputTail: outputTail.text,
					outputCharCount: outputTail.charCount,
					outputTruncated: outputTail.truncated,
				}),
		...(stderrTail === null
			? {}
			: {
					stderrTail: stderrTail.text,
					stderrTruncated: stderrTail.truncated,
				}),
		recentEvents: projectThreadEvents(thread.recentEvents, detail),
		nextSuggestedActions: nextSuggestedThreadActions(thread),
		...(detail === "full" && thread.lastAssistantText !== null
			? { lastAssistantText: thread.lastAssistantText }
			: {}),
	};

	if (thread.state === "live") {
		return {
			...common,
			phase: thread.phase,
			pid: thread.pid,
			...(detail === "full" && thread.lastPartialText !== null
				? { lastPartialText: thread.lastPartialText }
				: {}),
		};
	}

	return {
		...common,
		phase:
			thread.exit.kind === "stale" ? "stale" : isThreadExitFailed(thread.exit) ? "failed" : "idle",
		exit: thread.exit,
	};
}

function summarizeThreadResult(thread: ThreadSnapshot, detail: ThreadDetail): ThreadResultSummary {
	const partialText = thread.state === "live" ? nonBlankText(thread.lastPartialText) : null;
	const sourceText = partialText ?? nonBlankText(thread.lastAssistantText);
	if (sourceText === null) {
		return { status: "none", source: "none", text: null, charCount: 0, truncated: false };
	}

	const compact = compactText(sourceText);
	const limit = detail === "summary" ? 700 : detail === "tail" ? 1_200 : Number.POSITIVE_INFINITY;
	const text = limit === Number.POSITIVE_INFINITY ? compact : truncateText(compact, limit);
	return {
		status: partialText === null ? "completed" : "partial",
		source: partialText === null ? "assistant_message" : "assistant_partial",
		text,
		charCount: sourceText.length,
		truncated: text.length < compact.length,
	};
}

function currentAssistantOutputText(thread: ThreadSnapshot): string | null {
	const assistantText = nonBlankText(thread.lastAssistantText);
	if (thread.state === "closed") return assistantText;
	return nonBlankText(thread.lastPartialText) ?? assistantText;
}

function nonBlankText(text: string | null): string | null {
	return text === null || text.trim() === "" ? null : text;
}

function projectThreadEvents(
	events: readonly ThreadEvent[],
	detail: ThreadDetail,
): readonly ThreadEvent[] {
	const limit = detail === "summary" ? 5 : detail === "tail" ? 12 : events.length;
	const selected = events.slice(Math.max(0, events.length - limit));
	if (detail === "full") return [...selected];

	const textLimit = detail === "summary" ? 180 : 700;
	return selected.map((event) => projectThreadEvent(event, textLimit));
}

function projectThreadEvent(event: ThreadEvent, textLimit: number): ThreadEvent {
	if (event.type !== "assistant_message") return event;
	return { ...event, text: truncateText(compactText(event.text), textLimit) };
}

function compactText(text: string): string {
	return text.trim().replace(/\s+/gu, " ");
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= 1) return "…";
	return `${text.slice(0, maxLength - 1)}…`;
}

function tailText(
	text: string,
	maxLength: number,
): {
	readonly text: string;
	readonly charCount: number;
	readonly truncated: boolean;
} {
	if (text.length <= maxLength) return { text, charCount: text.length, truncated: false };
	return {
		text: `[truncated first ${text.length - maxLength} chars]\n${text.slice(-maxLength)}`,
		charCount: text.length,
		truncated: true,
	};
}

export function assertNever(value: never): never {
	throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

export function nowIso(): string {
	return new Date().toISOString();
}
