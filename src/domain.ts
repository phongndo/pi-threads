import { randomUUID } from "node:crypto";

declare const threadIdBrand: unique symbol;

export type ThreadId = string & { readonly [threadIdBrand]: "ThreadId" };

export type ThreadPhase = "starting" | "busy" | "idle" | "waiting_for_ui" | "stopping";

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

export function assertNever(value: never): never {
	throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

export function nowIso(): string {
	return new Date().toISOString();
}
