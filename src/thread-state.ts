import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
	nowIso,
	type ClosedThreadSnapshot,
	type LiveThreadSnapshot,
	type ThreadEvent,
	type ThreadExit,
	type ThreadId,
	type ThreadPath,
	type ThreadPhase,
	type ThreadSession,
	type ThreadSnapshot,
	type ThreadRuntimeSnapshot,
	toThreadRuntimeSnapshot,
} from "./domain.ts";
import { isRecord, stringField } from "./json.ts";
import {
	acceptedInitialPromptState,
	acceptedSendState,
	transitionAwaitingSend,
	type AwaitingSend,
	type AwaitingSendEvent,
} from "./awaiting-send.ts";
import type { SendMode } from "./schema.ts";
import type { RpcClient } from "./rpc.ts";
import type { ThreadRegistrySession } from "./thread-registry.ts";

const RECENT_EVENT_LIMIT = 40;
const BUSY_SEND_IDLE_SETTLE_REFRESHES = 2;
// Bound free-form assistant text retained on live threads. Registry persistence uses a
// separate, smaller limit in thread-registry.ts (REGISTRY_TEXT_LIMIT).
const RETAINED_TEXT_LIMIT = 100_000;

export type ThreadBase = {
	readonly id: ThreadId;
	readonly name: string;
	readonly taskName: string;
	readonly path: ThreadPath;
	readonly parentPath: ThreadPath;
	readonly parentThreadId: ThreadId | null;
	readonly depth: number;
	readonly registrySession: ThreadRegistrySession | null;
	readonly registryGeneration: number;
	archived: boolean;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createdAt: string;
	lastEventAt: string;
	session: ThreadSession;
	lastAssistantText: string | null;
	recentEvents: ThreadEvent[];
	nextEventSeq: number;
	stderrTail: string;
};

export type LiveThread = ThreadBase & {
	readonly state: "live";
	readonly processLaunchToken: symbol;
	readonly liveStartedAt: string;
	idleStartedAt: string | null;
	phase: ThreadPhase;
	readonly pid: number;
	readonly processGroupId: number | null;
	readonly child: ChildProcessWithoutNullStreams;
	readonly rpc: RpcClient;
	lastPartialText: string | null;
	stopRequested: boolean;
	hasRun: boolean;
	activityGeneration: number;
	userMessageStartGeneration: number;
	inFlightSendCount: number;
	awaitingSend: AwaitingSend | null;
	pendingInitialPrompt: PendingInitialPrompt | null;
	turnOpen: boolean;
	readonly closed: Promise<void>;
	readonly resolveClosed: () => void;
};

export type SendAcceptanceBaseline = {
	readonly phase: ThreadPhase;
	readonly activityGeneration: number;
	readonly userMessageStartGeneration: number;
	readonly pendingMessageCount: number | null;
	readonly allowActivityFastPath: boolean;
};

export type PendingInitialPrompt = {
	readonly requestId: string;
};

export type ClosedThread = ThreadBase & {
	readonly state: "closed";
	readonly exit: ThreadExit;
	readonly processLaunchToken?: symbol;
};

export type ManagedThread = LiveThread | ClosedThread;

export type LaunchThreadInput = {
	readonly id: ThreadId;
	readonly name: string;
	readonly taskName: string;
	readonly path: ThreadPath;
	readonly parentPath: ThreadPath;
	readonly parentThreadId: ThreadId | null;
	readonly depth: number;
	readonly registrySession: ThreadRegistrySession | null;
	readonly registryGeneration: number;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createdAt?: string;
	readonly archived?: boolean;
	readonly session?: ThreadSession | undefined;
	readonly sessionFile?: string | undefined;
	readonly lastAssistantText?: string | null | undefined;
	readonly recentEvents?: readonly ThreadEvent[] | undefined;
	readonly stderrTail?: string | undefined;
	readonly startEvent: "thread_started" | "thread_resumed" | "thread_forked";
	readonly sourceSessionFile?: string | undefined;
	readonly sourceEntryId?: string | null;
	readonly prompt?: string;
};

type ThreadEventInput = ThreadEvent extends infer Event
	? Event extends ThreadEvent
		? Omit<Event, "seq" | "at">
		: never
	: never;

export function snapshot(thread: ManagedThread): ThreadSnapshot {
	if (thread.state === "closed") {
		return {
			state: "closed",
			id: thread.id,
			name: thread.name,
			taskName: thread.taskName,
			path: thread.path,
			parentPath: thread.parentPath,
			parentThreadId: thread.parentThreadId,
			depth: thread.depth,
			archived: thread.archived,
			cwd: thread.cwd,
			args: [...thread.args],
			createdAt: thread.createdAt,
			lastEventAt: thread.lastEventAt,
			exit: thread.exit,
			session: thread.session,
			lastAssistantText: thread.lastAssistantText,
			recentEvents: [...thread.recentEvents],
			stderrTail: thread.stderrTail,
		} satisfies ClosedThreadSnapshot;
	}

	return {
		state: "live",
		id: thread.id,
		name: thread.name,
		taskName: thread.taskName,
		path: thread.path,
		parentPath: thread.parentPath,
		parentThreadId: thread.parentThreadId,
		depth: thread.depth,
		archived: thread.archived,
		cwd: thread.cwd,
		args: [...thread.args],
		createdAt: thread.createdAt,
		lastEventAt: thread.lastEventAt,
		pid: thread.pid,
		phase: thread.phase,
		session: thread.session,
		lastAssistantText: thread.lastAssistantText,
		lastPartialText: thread.lastPartialText,
		recentEvents: [...thread.recentEvents],
		stderrTail: thread.stderrTail,
	} satisfies LiveThreadSnapshot;
}

export function snapshotPair(thread: ManagedThread): {
	readonly thread: ThreadSnapshot;
	readonly snapshot: ThreadRuntimeSnapshot;
} {
	const threadSnapshot = snapshot(thread);
	return { thread: threadSnapshot, snapshot: toThreadRuntimeSnapshot(threadSnapshot) };
}

export function appendThreadEvent(thread: ThreadBase, event: ThreadEventInput): void {
	appendThreadEventAt(thread, event, nowIso());
}

export function appendThreadEventAt(thread: ThreadBase, event: ThreadEventInput, at: string): void {
	const nextEvent = { ...event, seq: thread.nextEventSeq, at } as ThreadEvent;
	thread.nextEventSeq++;
	thread.lastEventAt = at;
	thread.recentEvents.push(nextEvent);
	if (thread.recentEvents.length > RECENT_EVENT_LIMIT)
		thread.recentEvents.splice(0, thread.recentEvents.length - RECENT_EVENT_LIMIT);
}

export function appendLaunchThreadEvent(
	thread: LiveThread,
	input: LaunchThreadInput,
	pid: number,
): void {
	switch (input.startEvent) {
		case "thread_started":
			appendThreadEvent(thread, { type: "thread_started", pid });
			return;
		case "thread_resumed":
			appendThreadEvent(thread, { type: "thread_resumed", pid });
			return;
		case "thread_forked":
			appendThreadEvent(thread, {
				type: "thread_forked",
				pid,
				sourceSessionFile: input.sourceSessionFile ?? "unknown",
				sourceEntryId: input.sourceEntryId ?? null,
			});
			return;
	}
}

export function recordThreadTurnStarted(thread: LiveThread): void {
	if (thread.turnOpen) return;
	thread.turnOpen = true;
	appendThreadEvent(thread, { type: "turn_started" });
}

export function recordThreadTurnCompleted(thread: LiveThread): void {
	if (!thread.turnOpen) return;
	thread.turnOpen = false;
	appendThreadEvent(thread, { type: "turn_completed" });
}

export function setThreadPhase(thread: LiveThread, phase: ThreadPhase): void {
	if (thread.phase === phase) {
		if (phase === "idle" && thread.idleStartedAt === null) thread.idleStartedAt = nowIso();
		return;
	}

	thread.phase = phase;
	thread.idleStartedAt = phase === "idle" ? nowIso() : null;
}

export function defaultSendMode(phase: ThreadPhase): SendMode {
	return phase === "idle" ? "prompt" : "follow_up";
}

export function captureSendAcceptanceBaseline(
	thread: LiveThread,
	options: { readonly allowActivityFastPath?: boolean } = {},
): SendAcceptanceBaseline {
	const pendingMessageCount = getPendingMessageCount(thread);
	const allowActivityFastPath = options.allowActivityFastPath ?? true;
	return {
		phase: thread.phase,
		activityGeneration: thread.activityGeneration,
		userMessageStartGeneration: thread.userMessageStartGeneration,
		pendingMessageCount,
		allowActivityFastPath:
			allowActivityFastPath &&
			thread.phase === "idle" &&
			thread.awaitingSend === null &&
			(pendingMessageCount === null || pendingMessageCount === 0),
	};
}

export function recordAcceptedSend(thread: LiveThread, baseline: SendAcceptanceBaseline): void {
	const observedUserMessageStart =
		thread.userMessageStartGeneration > baseline.userMessageStartGeneration;
	const observedActivity =
		observedUserMessageStart ||
		(baseline.allowActivityFastPath && thread.activityGeneration !== baseline.activityGeneration);
	thread.awaitingSend = acceptedSendState({
		observedActivity,
		ignoreRunActivityUntilIdle: !baseline.allowActivityFastPath && thread.phase !== "idle",
		idleRefreshesToSettle: baseline.phase === "idle" ? 1 : BUSY_SEND_IDLE_SETTLE_REFRESHES,
		pendingMessageBaseline: baseline.pendingMessageCount,
	});
	if (thread.phase !== "stopping") {
		if (observedActivity && thread.phase === "idle") {
			clearObservedSendIfIdle(thread);
		} else {
			setThreadPhase(thread, "busy");
		}
	}
}

export function recordTimedOutSend(thread: LiveThread, baseline: SendAcceptanceBaseline): void {
	// The RPC request was written, but the response was not observed. Keep the
	// thread protected from idle cleanup until a later poll/wait confirms it is idle.
	thread.awaitingSend = acceptedSendState({
		observedActivity: false,
		ignoreRunActivityUntilIdle: !baseline.allowActivityFastPath && thread.phase !== "idle",
		idleRefreshesToSettle: baseline.phase === "idle" ? 1 : BUSY_SEND_IDLE_SETTLE_REFRESHES,
		pendingMessageBaseline: baseline.pendingMessageCount,
	});
	if (thread.phase !== "stopping") setThreadPhase(thread, "busy");
}

export function recordAcceptedInitialPrompt(thread: LiveThread): void {
	thread.awaitingSend ??= acceptedInitialPromptState(getPendingMessageCount(thread));
	if (thread.phase !== "stopping") setThreadPhase(thread, "busy");
}

export function recordPromptRunActivity(thread: LiveThread): void {
	clearPendingInitialPrompt(thread);
	recordSendActivity(thread);
}

export function clearPendingInitialPrompt(thread: LiveThread): void {
	thread.pendingInitialPrompt = null;
}

export function recordSendActivity(thread: LiveThread): void {
	thread.activityGeneration++;
	// Child-side activity while the thread remains idle should start a fresh
	// idle-cleanup window without letting parent-side polls extend it.
	if (thread.phase === "idle") thread.idleStartedAt = nowIso();
	applyAwaitingSend(thread, { type: "run_activity" });
}

export function allowAwaitingSendRunActivity(thread: LiveThread): void {
	applyAwaitingSend(thread, { type: "allow_run_activity" });
}

export function recordPendingMessageActivity(
	thread: LiveThread,
	pendingMessageCount: number,
): void {
	const result = applyAwaitingSend(thread, {
		type: "pending_messages",
		count: pendingMessageCount,
	});
	if (result.observedNewActivity) thread.activityGeneration++;
}

export function clearObservedSendIfIdle(thread: LiveThread): void {
	applyAwaitingSend(thread, { type: "clear_if_idle", phase: thread.phase });
}

export function applyAwaitingSend(
	thread: LiveThread,
	event: AwaitingSendEvent,
): { readonly observedNewActivity: boolean; readonly phase: ThreadPhase | undefined } {
	if (thread.awaitingSend === null) {
		return { observedNewActivity: false, phase: undefined };
	}
	const result = transitionAwaitingSend(thread.awaitingSend, event);
	thread.awaitingSend = result.state;
	return { observedNewActivity: result.observedNewActivity, phase: result.phase };
}

export function getPendingMessageCount(thread: ManagedThread): number | null {
	return thread.session.kind === "known" ? thread.session.pendingMessageCount : null;
}

export function hasNoPendingMessages(thread: ManagedThread): boolean {
	const pendingMessageCount = getPendingMessageCount(thread);
	return pendingMessageCount === null || pendingMessageCount === 0;
}

export function extractAssistantText(message: unknown): string | null {
	if (!isRecord(message) || message["role"] !== "assistant") return null;
	const content = message["content"];
	if (!Array.isArray(content)) return null;

	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part) || part["type"] !== "text") continue;
		const text = stringField(part, "text");
		if (text !== null) parts.push(text);
	}

	return parts.length === 0 ? null : parts.join("\n");
}

export function isUserMessage(message: unknown): boolean {
	return isRecord(message) && message["role"] === "user";
}

export function tail(text: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return text;

	let result = text.slice(-maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(1);
	return `[truncated ${bytes - Buffer.byteLength(result, "utf8")} bytes]\n${result}`;
}

export function capRetainedText(text: string): string {
	if (text.length <= RETAINED_TEXT_LIMIT) return text;
	return `${text.slice(0, RETAINED_TEXT_LIMIT)}\n[truncated ${text.length - RETAINED_TEXT_LIMIT} chars for memory retention]`;
}
