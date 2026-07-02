import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	asThreadId,
	newThreadId,
	nowIso,
	type ClosedThreadSnapshot,
	type LiveThreadSnapshot,
	type ThreadEvent,
	type ThreadExit,
	type ThreadId,
	type ThreadPhase,
	type ThreadSession,
	type ThreadSnapshot,
} from "./domain.ts";
import { isRecord, numberField, stringField } from "./json.ts";
import { RpcClient, type RpcClientEvent } from "./rpc.ts";
import type { SendCommand, SendMode, StartCommand, StopCommand } from "./schema.ts";

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_THREADS = 8;
const RECENT_EVENT_LIMIT = 40;
const STDERR_TAIL_LIMIT = 12_000;
const PROMPT_ACCEPT_TIMEOUT_MS = 4_000;
const RPC_QUICK_TIMEOUT_MS = 1_500;
const RPC_SEND_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 1_500;

type ThreadBase = {
	readonly id: ThreadId;
	readonly name: string;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createdAt: string;
	lastEventAt: string;
	session: ThreadSession;
	lastAssistantText: string | null;
	lastPartialText: string | null;
	recentEvents: ThreadEvent[];
	stderrTail: string;
};

type LiveThread = ThreadBase & {
	readonly state: "live";
	phase: ThreadPhase;
	readonly pid: number;
	readonly child: ChildProcessWithoutNullStreams;
	readonly rpc: RpcClient;
	stopRequested: boolean;
	readonly closed: Promise<void>;
	readonly resolveClosed: () => void;
};

type ClosedThread = ThreadBase & {
	readonly state: "closed";
	readonly exit: ThreadExit;
};

type ManagedThread = LiveThread | ClosedThread;

export type StartOutcome = {
	readonly kind: "started";
	readonly promptAccepted: boolean;
	readonly note: string | null;
	readonly thread: ThreadSnapshot;
};

export type SendOutcome = {
	readonly kind: "sent";
	readonly mode: SendMode;
	readonly accepted: boolean;
	readonly error: string | null;
	readonly thread: ThreadSnapshot;
};

export type StopOutcome = {
	readonly kind: "stopped";
	readonly thread: ThreadSnapshot;
};

export class ThreadManager {
	readonly #threads = new Map<ThreadId, ManagedThread>();
	readonly #depth: number;
	readonly #maxDepth: number;
	readonly #maxThreads: number;

	constructor(environment: NodeJS.ProcessEnv = process.env) {
		this.#depth = readInteger(environment["PI_THREADS_DEPTH"], 0);
		this.#maxDepth = readInteger(environment["PI_THREADS_MAX_DEPTH"], DEFAULT_MAX_DEPTH);
		this.#maxThreads = readInteger(environment["PI_THREADS_MAX_THREADS"], DEFAULT_MAX_THREADS);
	}

	list(): readonly ThreadSnapshot[] {
		return Array.from(this.#threads.values(), (thread) => snapshot(thread));
	}

	async start(command: StartCommand, ctx: ExtensionContext): Promise<StartOutcome> {
		this.#assertStartAllowed();

		const id = newThreadId();
		const name = command.name ?? id;
		const cwd = resolveCwd(ctx.cwd, command.cwd);
		const extraArgs = command.args ?? [];
		assertAllowedExtraArgs(extraArgs);

		const argv = buildPiArgs({
			name,
			extraArgs,
			projectTrusted: ctx.isProjectTrusted(),
		});
		const invocation = getPiInvocation(argv);
		const childEnvironment = {
			...process.env,
			PI_THREADS_DEPTH: String(this.#depth + 1),
			PI_THREADS_MAX_DEPTH: String(this.#maxDepth),
			PI_THREADS_PARENT_ID: id,
		};

		const child = spawn(invocation.command, invocation.args, {
			cwd,
			env: childEnvironment,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (child.pid === undefined) {
			child.kill("SIGKILL");
			throw new Error("Unable to start child Pi process: missing pid");
		}

		const closedDeferred = createDeferred<void>();

		const thread: LiveThread = {
			state: "live",
			id,
			name,
			cwd,
			args: [...extraArgs],
			createdAt: nowIso(),
			lastEventAt: nowIso(),
			session: { kind: "unknown" },
			lastAssistantText: null,
			lastPartialText: null,
			recentEvents: [],
			stderrTail: "",
			phase: "starting",
			pid: child.pid,
			child,
			rpc: new RpcClient(child, (event) => this.#handleRpcEvent(id, event)),
			stopRequested: false,
			closed: closedDeferred.promise,
			resolveClosed: closedDeferred.resolve,
		};

		this.#threads.set(id, thread);
		pushEvent(thread, { kind: "state", at: nowIso(), message: `started pid ${child.pid}` });

		child.stderr.on("data", (chunk: Buffer | string) => {
			const current = this.#threads.get(id);
			if (!current) return;
			current.stderrTail = tail(`${current.stderrTail}${String(chunk)}`, STDERR_TAIL_LIMIT);
			current.lastEventAt = nowIso();
		});

		child.once("error", (error) => {
			this.#closeThread(id, { kind: "failed", message: error.message });
		});

		child.once("close", (code, signal) => {
			const current = this.#threads.get(id);
			const stopped = current?.state === "live" && current.stopRequested;
			this.#closeThread(id, {
				kind: stopped ? "stopped" : "exited",
				code,
				signal,
			});
		});

		let note: string | null = null;
		let promptAccepted = false;
		try {
			const response = await thread.rpc.request(
				{ type: "prompt", message: command.prompt },
				PROMPT_ACCEPT_TIMEOUT_MS,
			);
			promptAccepted = response.success;
			if (!response.success) note = response.error ?? "Prompt was rejected by child Pi.";
		} catch (error) {
			note = error instanceof Error ? error.message : String(error);
		}

		return { kind: "started", promptAccepted, note, thread: snapshot(this.#required(id)) };
	}

	async poll(idText: string): Promise<ThreadSnapshot> {
		const id = asThreadId(idText);
		const thread = this.#required(id);

		if (thread.state === "live") {
			await this.#refreshState(thread);
		}

		return snapshot(this.#required(id));
	}

	async send(command: SendCommand): Promise<SendOutcome> {
		const thread = this.#live(command.id);
		const mode = command.mode ?? defaultSendMode(thread.phase);
		const response = await sendMessage(thread, mode, command.message);

		return {
			kind: "sent",
			mode,
			accepted: response.success,
			error: response.success ? null : (response.error ?? "Message was rejected by child Pi."),
			thread: snapshot(thread),
		};
	}

	async stop(command: StopCommand): Promise<StopOutcome> {
		const id = asThreadId(command.id);
		const thread = this.#required(id);

		if (thread.state === "closed") return { kind: "stopped", thread: snapshot(thread) };

		thread.stopRequested = true;
		thread.phase = "stopping";
		pushEvent(thread, { kind: "state", at: nowIso(), message: "stopping" });

		if (command.force === true) {
			thread.child.kill("SIGKILL");
		} else {
			await thread.rpc.request({ type: "abort" }, RPC_QUICK_TIMEOUT_MS).catch(() => undefined);
			thread.child.kill("SIGTERM");
			await delay(STOP_GRACE_MS);
			if (this.#threads.get(id)?.state === "live") thread.child.kill("SIGKILL");
		}

		await Promise.race([thread.closed, delay(STOP_GRACE_MS)]);
		return { kind: "stopped", thread: snapshot(this.#required(id)) };
	}

	async shutdown(): Promise<void> {
		const liveThreads = Array.from(this.#threads.values()).filter(
			(thread): thread is LiveThread => thread.state === "live",
		);
		await Promise.all(
			liveThreads.map(async (thread) => {
				thread.stopRequested = true;
				thread.child.kill("SIGTERM");
				await Promise.race([thread.closed, delay(300)]);
				if (this.#threads.get(thread.id)?.state === "live") thread.child.kill("SIGKILL");
			}),
		);
	}

	#assertStartAllowed(): void {
		if (this.#depth >= this.#maxDepth) {
			throw new Error(
				`pi-threads recursion depth ${this.#depth} has reached PI_THREADS_MAX_DEPTH=${this.#maxDepth}`,
			);
		}

		const liveCount = Array.from(this.#threads.values()).filter(
			(thread) => thread.state === "live",
		).length;
		if (liveCount >= this.#maxThreads) {
			throw new Error(`pi-threads live thread limit reached: ${liveCount}/${this.#maxThreads}`);
		}
	}

	#required(id: ThreadId): ManagedThread {
		const thread = this.#threads.get(id);
		if (!thread) throw new Error(`Unknown thread id: ${id}`);
		return thread;
	}

	#live(idText: string): LiveThread {
		const thread = this.#required(asThreadId(idText));
		if (thread.state === "closed") throw new Error(`Thread is closed: ${idText}`);
		return thread;
	}

	#closeThread(id: ThreadId, exit: ThreadExit): void {
		const thread = this.#threads.get(id);
		if (!thread || thread.state === "closed") return;

		const closed: ClosedThread = {
			state: "closed",
			id: thread.id,
			name: thread.name,
			cwd: thread.cwd,
			args: thread.args,
			createdAt: thread.createdAt,
			lastEventAt: nowIso(),
			session: thread.session,
			lastAssistantText: thread.lastAssistantText,
			lastPartialText: null,
			recentEvents: thread.recentEvents,
			stderrTail: thread.stderrTail,
			exit,
		};

		pushEvent(closed, { kind: "state", at: nowIso(), message: `closed: ${exit.kind}` });
		this.#threads.set(id, closed);
		thread.resolveClosed();
	}

	#handleRpcEvent(id: ThreadId, clientEvent: RpcClientEvent): void {
		const thread = this.#threads.get(id);
		if (!thread || thread.state === "closed") return;

		thread.lastEventAt = nowIso();

		if (clientEvent.kind === "parse_error") {
			pushEvent(thread, { kind: "error", at: nowIso(), message: clientEvent.message });
			return;
		}

		if (clientEvent.kind === "response") return;

		const event = clientEvent.event;
		const type = stringField(event, "type");
		switch (type) {
			case "agent_start": {
				thread.phase = "busy";
				pushEvent(thread, { kind: "state", at: nowIso(), message: "agent started" });
				return;
			}
			case "agent_end": {
				thread.phase = "idle";
				thread.lastPartialText = null;
				pushEvent(thread, { kind: "state", at: nowIso(), message: "agent ended" });
				return;
			}
			case "message_update": {
				const text = extractAssistantText(event["message"]);
				if (text !== null) thread.lastPartialText = text;
				return;
			}
			case "message_end": {
				const text = extractAssistantText(event["message"]);
				if (text !== null) {
					thread.lastAssistantText = text;
					thread.lastPartialText = null;
					pushEvent(thread, { kind: "assistant", at: nowIso(), text: tail(text, 2_000) });
				}
				return;
			}
			case "tool_execution_start": {
				thread.phase = "busy";
				pushEvent(thread, {
					kind: "tool",
					at: nowIso(),
					phase: "start",
					name: stringField(event, "toolName") ?? "unknown",
					error: false,
				});
				return;
			}
			case "tool_execution_end": {
				pushEvent(thread, {
					kind: "tool",
					at: nowIso(),
					phase: "end",
					name: stringField(event, "toolName") ?? "unknown",
					error: event["isError"] === true,
				});
				return;
			}
			case "extension_ui_request": {
				const requestId = stringField(event, "id");
				const method = stringField(event, "method") ?? "unknown";
				const shouldAutoCancel = requestId !== null && isDialogUiMethod(method);
				if (requestId !== null && !shouldAutoCancel) thread.phase = "waiting_for_ui";
				pushEvent(thread, {
					kind: "ui",
					at: nowIso(),
					method,
					title: stringField(event, "title"),
					autoCancelled: shouldAutoCancel,
				});
				if (shouldAutoCancel) thread.rpc.respondToUiRequest(requestId);
				return;
			}
			default:
				return;
		}
	}

	async #refreshState(thread: LiveThread): Promise<void> {
		const response = await thread.rpc
			.request({ type: "get_state" }, RPC_QUICK_TIMEOUT_MS)
			.catch((error: unknown) => {
				pushEvent(thread, {
					kind: "error",
					at: nowIso(),
					message: error instanceof Error ? error.message : String(error),
				});
				return null;
			});

		if (!response?.success || !isRecord(response.data)) return;

		const file = stringField(response.data, "sessionFile");
		const id = stringField(response.data, "sessionId");
		if (file !== null && id !== null) {
			thread.session = {
				kind: "known",
				file,
				id,
				name: stringField(response.data, "sessionName"),
				pendingMessageCount: numberField(response.data, "pendingMessageCount"),
			};
		}

		const isStreaming = response.data["isStreaming"] === true;
		if (thread.phase !== "stopping" && thread.phase !== "waiting_for_ui")
			thread.phase = isStreaming ? "busy" : "idle";
	}
}

export function buildPiArgs(input: {
	readonly name: string;
	readonly extraArgs: readonly string[];
	readonly projectTrusted: boolean;
}): readonly string[] {
	return [
		...input.extraArgs,
		"--mode",
		"rpc",
		"--name",
		input.name,
		input.projectTrusted ? "--approve" : "--no-approve",
	] as const;
}

export function assertAllowedExtraArgs(args: readonly string[]): void {
	const forbidden = new Set([
		"--mode",
		"-p",
		"--print",
		"--help",
		"-h",
		"--version",
		"-v",
		"--export",
		"--list-models",
	]);

	for (const arg of args) {
		const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		if (forbidden.has(flag)) {
			throw new Error(`Unsupported child Pi arg for pi-threads: ${arg}`);
		}
	}
}

function snapshot(thread: ManagedThread): ThreadSnapshot {
	if (thread.state === "closed") {
		return {
			state: "closed",
			id: thread.id,
			name: thread.name,
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

function pushEvent(thread: ThreadBase, event: ThreadEvent): void {
	thread.lastEventAt = event.at;
	thread.recentEvents.push(event);
	if (thread.recentEvents.length > RECENT_EVENT_LIMIT)
		thread.recentEvents.splice(0, thread.recentEvents.length - RECENT_EVENT_LIMIT);
}

function resolveCwd(parentCwd: string, childCwd: string | undefined): string {
	if (childCwd === undefined) return parentCwd;
	return path.resolve(parentCwd, childCwd);
}

function defaultSendMode(phase: ThreadPhase): SendMode {
	return phase === "idle" ? "prompt" : "follow_up";
}

async function sendMessage(thread: LiveThread, mode: SendMode, message: string) {
	switch (mode) {
		case "prompt":
			return thread.rpc.request({ type: "prompt", message }, RPC_SEND_TIMEOUT_MS);
		case "steer":
			return thread.rpc.request({ type: "steer", message }, RPC_SEND_TIMEOUT_MS);
		case "follow_up":
			return thread.rpc.request({ type: "follow_up", message }, RPC_SEND_TIMEOUT_MS);
	}
}

function getPiInvocation(args: readonly string[]): {
	readonly command: string;
	readonly args: readonly string[];
} {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/u.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

function extractAssistantText(message: unknown): string | null {
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

function tail(text: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return text;

	let result = text.slice(-maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(1);
	return `[truncated ${bytes - Buffer.byteLength(result, "utf8")} bytes]\n${result}`;
}

function readInteger(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isDialogUiMethod(method: string): boolean {
	return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createDeferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});

	return { promise, resolve: resolve! };
}
