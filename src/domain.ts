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
	| { readonly kind: "state"; readonly at: string; readonly message: string }
	| { readonly kind: "assistant"; readonly at: string; readonly text: string }
	| {
			readonly kind: "tool";
			readonly at: string;
			readonly phase: "start" | "end";
			readonly name: string;
			readonly error: boolean;
	  }
	| {
			readonly kind: "ui";
			readonly at: string;
			readonly method: string;
			readonly title: string | null;
			readonly autoCancelled: boolean;
	  }
	| { readonly kind: "error"; readonly at: string; readonly message: string };

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

export function assertNever(value: never): never {
	throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

export function nowIso(): string {
	return new Date().toISOString();
}
