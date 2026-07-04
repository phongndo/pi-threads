import { randomUUID } from "node:crypto";

declare const threadIdBrand: unique symbol;
declare const threadPathBrand: unique symbol;

export type ThreadId = string & { readonly [threadIdBrand]: "ThreadId" };
export type ThreadPath = string & { readonly [threadPathBrand]: "ThreadPath" };

export const ROOT_THREAD_PATH = asThreadPath("/root");

export type ThreadPhase = "starting" | "busy" | "idle" | "stopping";

export type ThreadSession =
	| { readonly kind: "unknown" }
	| {
			readonly kind: "known";
			readonly file: string;
			readonly id: string;
			readonly name: string | null;
			readonly pendingMessageCount: number | null;
	  };

export type ThreadExit =
	| { readonly kind: "exited"; readonly code: number | null; readonly signal: string | null }
	| { readonly kind: "stopped"; readonly code: number | null; readonly signal: string | null }
	| { readonly kind: "failed"; readonly message: string };

export type ThreadEvent =
	| {
			readonly seq: number;
			readonly at: string;
			readonly type: "thread_started";
			readonly pid: number;
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

export type LiveThreadSnapshot = {
	readonly state: "live";
	readonly id: ThreadId;
	readonly name: string;
	readonly taskName: string;
	readonly path: ThreadPath;
	readonly parentPath: ThreadPath;
	readonly parentThreadId: ThreadId | null;
	readonly depth: number;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createdAt: string;
	readonly lastEventAt: string;
	readonly pid: number;
	readonly phase: ThreadPhase;
	readonly session: ThreadSession;
	readonly lastAssistantText: string | null;
	readonly lastPartialText: string | null;
	readonly recentEvents: readonly ThreadEvent[];
	readonly stderrTail: string;
};

export type ClosedThreadSnapshot = {
	readonly state: "closed";
	readonly id: ThreadId;
	readonly name: string;
	readonly taskName: string;
	readonly path: ThreadPath;
	readonly parentPath: ThreadPath;
	readonly parentThreadId: ThreadId | null;
	readonly depth: number;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createdAt: string;
	readonly lastEventAt: string;
	readonly exit: ThreadExit;
	readonly session: ThreadSession;
	readonly lastAssistantText: string | null;
	readonly recentEvents: readonly ThreadEvent[];
	readonly stderrTail: string;
};

export type ThreadSnapshot = LiveThreadSnapshot | ClosedThreadSnapshot;

export type ThreadRuntimeStatus = "live" | "closed";

export type ThreadRuntimePhase = ThreadPhase | "failed";

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
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createdAt: string;
	readonly lastEventAt: string;
	readonly pid?: number;
	readonly exit?: ThreadExit;
	readonly session: ThreadSession;
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
	if (thread.state === "closed") return ["list"];
	if (thread.phase === "idle") return ["send prompt", "poll", "stop"];
	if (thread.phase === "stopping") return ["poll", "wait"];
	return ["wait", "poll", "send follow_up", "stop"];
}

export function toThreadRuntimeSnapshot(thread: ThreadSnapshot): ThreadRuntimeSnapshot {
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
		cwd: thread.cwd,
		args: [...thread.args],
		createdAt: thread.createdAt,
		lastEventAt: thread.lastEventAt,
		session: thread.session,
		recentEvents: [...thread.recentEvents],
		nextSuggestedActions: nextSuggestedThreadActions(thread),
		...(thread.lastAssistantText === null ? {} : { lastAssistantText: thread.lastAssistantText }),
	};

	if (thread.state === "live") {
		return {
			...common,
			phase: thread.phase,
			pid: thread.pid,
			...(thread.lastPartialText === null ? {} : { lastPartialText: thread.lastPartialText }),
		};
	}

	return {
		...common,
		phase: isThreadExitFailed(thread.exit) ? "failed" : "idle",
		exit: thread.exit,
	};
}

export function assertNever(value: never): never {
	throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

export function nowIso(): string {
	return new Date().toISOString();
}
