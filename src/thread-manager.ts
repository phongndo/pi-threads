import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ROOT_THREAD_PATH,
	asThreadPath,
	asThreadId,
	assertTaskName,
	isThreadIdText,
	joinThreadPath,
	newThreadId,
	nowIso,
	threadPathBasename,
	type ClosedThreadSnapshot,
	type LiveThreadSnapshot,
	type ThreadEvent,
	type ThreadExit,
	type ThreadId,
	type ThreadPath,
	type ThreadRuntimeSnapshot,
	type ThreadPhase,
	type ThreadSession,
	type ThreadSnapshot,
	toThreadRuntimeSnapshot,
} from "./domain.ts";
import { isRecord, numberField, stringField } from "./json.ts";
import { RpcClient, type RpcClientEvent, type RpcResponse } from "./rpc.ts";
import type {
	ListCommand,
	SendCommand,
	SendMode,
	StartCommand,
	StopCommand,
	WaitCommand,
} from "./schema.ts";

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_THREADS = 8;
const RECENT_EVENT_LIMIT = 40;
const STDERR_TAIL_LIMIT = 12_000;
const PROMPT_ACCEPT_TIMEOUT_MS = 4_000;
const RPC_QUICK_TIMEOUT_MS = 1_500;
const RPC_SEND_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 1_500;
const STOP_KILL_WAIT_MS = 300;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;
const WAIT_POLL_INTERVAL_MS = 250;
const BUSY_SEND_IDLE_SETTLE_REFRESHES = 2;
const TASK_NAME_MAX_LENGTH = 64;
const DISPLAY_NAME_MAX_LENGTH = 80;
// Pi resolves CLI resource flags from the process startup cwd, while ctx.cwd can
// later point at a resumed or switched session in another project.
const PROCESS_START_CWD = process.cwd();

type ThreadBase = {
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
	lastEventAt: string;
	session: ThreadSession;
	lastAssistantText: string | null;
	recentEvents: ThreadEvent[];
	nextEventSeq: number;
	stderrTail: string;
};

type LiveThread = ThreadBase & {
	readonly state: "live";
	phase: ThreadPhase;
	readonly pid: number;
	readonly child: ChildProcessWithoutNullStreams;
	readonly rpc: RpcClient;
	lastPartialText: string | null;
	stopRequested: boolean;
	hasRun: boolean;
	activityGeneration: number;
	userMessageStartGeneration: number;
	awaitingSend: AwaitingSend | null;
	pendingInitialPrompt: PendingInitialPrompt | null;
	turnOpen: boolean;
	readonly closed: Promise<void>;
	readonly resolveClosed: () => void;
};

type AwaitingSend = {
	observedActivity: boolean;
	requireObservedActivity: boolean;
	ignoreRunActivityUntilIdle: boolean;
	idleRefreshCount: number;
	readonly idleRefreshesToSettle: number;
	readonly pendingMessageBaseline: number | null;
};

type SendAcceptanceBaseline = {
	readonly phase: ThreadPhase;
	readonly activityGeneration: number;
	readonly userMessageStartGeneration: number;
	readonly pendingMessageCount: number | null;
	readonly allowActivityFastPath: boolean;
};

type PendingInitialPrompt = {
	readonly requestId: string;
};

type ClosedThread = ThreadBase & {
	readonly state: "closed";
	readonly exit: ThreadExit;
};

type ManagedThread = LiveThread | ClosedThread;

export type ThreadChangeListener = (threads: readonly ThreadSnapshot[]) => void;

export type ThreadManagerScope = {
	readonly currentPath: ThreadPath;
	readonly depth: number;
	readonly selfThreadId: ThreadId | null;
};

export type StartOutcome = {
	readonly kind: "started";
	readonly promptAccepted: boolean;
	readonly note: string | null;
	readonly thread: ThreadSnapshot;
	readonly snapshot: ThreadRuntimeSnapshot;
};

export type SendOutcome = {
	readonly kind: "sent";
	readonly mode: SendMode;
	readonly accepted: boolean;
	readonly error: string | null;
	readonly thread: ThreadSnapshot;
	readonly snapshot: ThreadRuntimeSnapshot;
};

export type StopOutcome = {
	readonly kind: "stopped";
	readonly thread: ThreadSnapshot;
	readonly snapshot: ThreadRuntimeSnapshot;
};

export type WaitOutcome = {
	readonly kind: "waited";
	readonly timedOut: boolean;
	readonly waitedMs: number;
	readonly thread: ThreadSnapshot;
	readonly snapshot: ThreadRuntimeSnapshot;
};

export type WaitProgress = {
	readonly waitedMs: number;
	readonly thread: ThreadSnapshot;
	readonly snapshot: ThreadRuntimeSnapshot;
};

type WaitOptions = {
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: WaitProgress) => void;
};

export class ThreadManager {
	readonly #threads = new Map<ThreadId, ManagedThread>();
	readonly #listeners = new Set<ThreadChangeListener>();
	readonly #baseScope: ThreadManagerScope;
	#depth: number;
	readonly #maxDepth: number;
	readonly #maxThreads: number;
	#selfThreadId: ThreadId | null;
	#currentPath: ThreadPath;
	readonly #rootSessionId: string;

	constructor(environment: NodeJS.ProcessEnv = process.env) {
		const baseDepth = readInteger(environment["PI_THREADS_DEPTH"], 0);
		const baseSelfThreadId = readOptionalThreadId(environment["PI_THREADS_SELF_ID"]);
		const baseCurrentPath = readThreadPath(environment["PI_THREADS_PATH"], ROOT_THREAD_PATH);
		this.#baseScope = {
			currentPath: baseCurrentPath,
			depth: baseDepth,
			selfThreadId: baseSelfThreadId,
		};
		this.#depth = baseDepth;
		this.#maxDepth = readInteger(environment["PI_THREADS_MAX_DEPTH"], DEFAULT_MAX_DEPTH);
		this.#maxThreads = readInteger(environment["PI_THREADS_MAX_THREADS"], DEFAULT_MAX_THREADS);
		this.#selfThreadId = baseSelfThreadId;
		this.#currentPath = baseCurrentPath;
		this.#rootSessionId = environment["PI_THREADS_ROOT_SESSION_ID"] ?? `root_${process.pid}`;
	}

	onChange(listener: ThreadChangeListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getScope(): ThreadManagerScope {
		return {
			currentPath: this.#currentPath,
			depth: this.#depth,
			selfThreadId: this.#selfThreadId,
		};
	}

	resetScope(): void {
		this.rebindScope(this.#baseScope);
	}

	rebindScope(scope: ThreadManagerScope): void {
		this.#currentPath = scope.currentPath;
		this.#depth = scope.depth;
		this.#selfThreadId = scope.selfThreadId;
	}

	findBySessionFile(sessionFile: string): ThreadSnapshot | undefined {
		const thread = Array.from(this.#threads.values()).find(
			(candidate) =>
				candidate.session.kind === "known" && sameSessionFile(candidate.session.file, sessionFile),
		);
		return thread === undefined ? undefined : snapshot(thread);
	}

	list(command?: ListCommand): readonly ThreadSnapshot[] {
		let threads = Array.from(this.#threads.values());

		const state = command?.state ?? "all";
		if (state !== "all") threads = threads.filter((thread) => thread.state === state);

		const parent = command && "parent" in command ? command.parent : undefined;
		if (parent !== undefined) {
			const parentPath = this.#resolveListPathReference(parent);
			threads = threads.filter((thread) => thread.parentPath === parentPath);
		}

		const ancestor = command && "ancestor" in command ? command.ancestor : undefined;
		if (ancestor !== undefined) {
			const ancestorPath = this.#resolveListPathReference(ancestor);
			threads = threads.filter(
				(thread) => thread.path !== ancestorPath && thread.path.startsWith(`${ancestorPath}/`),
			);
		}

		threads.sort((left, right) => left.path.localeCompare(right.path));
		return threads.map((thread) => snapshot(thread));
	}

	async start(command: StartCommand, ctx: ExtensionContext): Promise<StartOutcome> {
		this.#assertStartAllowed();

		const id = newThreadId();
		const taskName = command.taskName ?? this.#generateUniqueTaskName(command, id);
		assertTaskName(taskName);
		const threadPath = joinThreadPath(this.#currentPath, taskName);
		this.#assertPathAvailable(threadPath);

		const name = command.name ?? generateDisplayName(command.prompt, taskName, id);
		const cwd = resolveCwd(ctx.cwd, command.cwd);
		const extraArgs = command.args ?? [];
		assertAllowedExtraArgs(extraArgs);
		const inheritedArgs = collectInheritedPiArgs(process.argv, PROCESS_START_CWD);
		const argv = buildPiArgs({
			name,
			extraArgs,
			inheritedArgs,
			projectTrusted: shouldApproveChildCwd(ctx.isProjectTrusted(), ctx.cwd, cwd),
		});
		const invocation = getPiInvocation(argv);
		const childEnvironment = {
			...process.env,
			PI_THREADS_DEPTH: String(this.#depth + 1),
			PI_THREADS_MAX_DEPTH: String(this.#maxDepth),
			PI_THREADS_MAX_THREADS: String(this.#maxThreads),
			PI_THREADS_SELF_ID: id,
			PI_THREADS_PARENT_ID: this.#selfThreadId ?? "",
			PI_THREADS_PARENT_THREAD_ID: this.#selfThreadId ?? "",
			PI_THREADS_PARENT_PATH: this.#currentPath,
			PI_THREADS_PATH: threadPath,
			PI_THREADS_ROOT_SESSION_ID: this.#rootSessionId,
		};

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(invocation.command, invocation.args, {
				cwd,
				env: childEnvironment,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Unable to start child Pi process: ${message}`, { cause: error });
		}

		const pendingStart: {
			spawnError: Error | null;
			close: { readonly code: number | null; readonly signal: string | null } | null;
		} = { spawnError: null, close: null };
		child.once("error", (error) => {
			if (!this.#threads.has(id)) {
				pendingStart.spawnError = error;
				return;
			}
			this.#closeThread(id, { kind: "failed", message: error.message });
		});

		child.once("close", (code, signal) => {
			const current = this.#threads.get(id);
			if (current === undefined) {
				pendingStart.close = { code, signal };
				return;
			}
			const stopped = current.state === "live" && current.stopRequested;
			this.#closeThread(id, classifyProcessExit({ code, signal, stopped }));
		});

		if (child.pid === undefined) {
			child.kill("SIGKILL");
			const reason =
				pendingStart.spawnError === null ? "missing pid" : pendingStart.spawnError.message;
			throw new Error(`Unable to start child Pi process: ${reason}`);
		}

		const closedDeferred = createDeferred<void>();

		const thread: LiveThread = {
			state: "live",
			id,
			name,
			taskName,
			path: threadPath,
			parentPath: this.#currentPath,
			parentThreadId: this.#selfThreadId,
			depth: this.#depth + 1,
			cwd,
			args: [...extraArgs],
			createdAt: nowIso(),
			lastEventAt: nowIso(),
			session: { kind: "unknown" },
			lastAssistantText: null,
			lastPartialText: null,
			recentEvents: [],
			nextEventSeq: 1,
			stderrTail: "",
			phase: "starting",
			pid: child.pid,
			child,
			rpc: new RpcClient(child, (event) => this.#handleRpcEvent(id, event)),
			stopRequested: false,
			hasRun: false,
			activityGeneration: 0,
			userMessageStartGeneration: 0,
			awaitingSend: null,
			pendingInitialPrompt: null,
			turnOpen: false,
			closed: closedDeferred.promise,
			resolveClosed: closedDeferred.resolve,
		};

		this.#threads.set(id, thread);
		appendThreadEvent(thread, { type: "thread_started", pid: child.pid });
		this.#emitChange();

		child.stderr.on("data", (chunk: Buffer | string) => {
			const current = this.#threads.get(id);
			if (!current) return;
			current.stderrTail = tail(`${current.stderrTail}${String(chunk)}`, STDERR_TAIL_LIMIT);
			current.lastEventAt = nowIso();
		});

		if (pendingStart.spawnError !== null) {
			this.#closeThread(id, { kind: "failed", message: pendingStart.spawnError.message });
		} else if (pendingStart.close !== null) {
			this.#closeThread(
				id,
				classifyProcessExit({
					code: pendingStart.close.code,
					signal: pendingStart.close.signal,
					stopped: thread.stopRequested,
				}),
			);
		}

		await this.#refreshSession(thread);

		let note: string | null = null;
		let promptAccepted = false;
		try {
			const request = thread.rpc.requestWithHandle(
				{ type: "prompt", message: command.prompt },
				PROMPT_ACCEPT_TIMEOUT_MS,
			);
			thread.pendingInitialPrompt = { requestId: request.id };

			const response = await request.response;
			promptAccepted = response.success;
			this.#recordInitialPromptResponse(id, response);
			if (!response.success) {
				note = response.error ?? "Prompt was rejected by child Pi.";
			}
		} catch (error) {
			note = error instanceof Error ? error.message : String(error);
		}
		const current = this.#threads.get(id);
		if (current?.state === "live" && current.session.kind !== "known") {
			await this.#refreshSession(current);
		}
		this.#emitChange();

		const resultThread = snapshotPair(this.#required(id));
		return {
			kind: "started",
			promptAccepted,
			note,
			...resultThread,
		};
	}

	async poll(idText: string): Promise<ThreadSnapshot> {
		const thread = this.#requiredByTarget(idText);

		if (thread.state === "live") {
			await this.#refreshState(thread, { emitChange: false });
		}
		this.#emitChange();

		return snapshot(this.#required(thread.id));
	}

	async send(command: SendCommand): Promise<SendOutcome> {
		let thread = this.#liveByTarget(command.id);
		const refreshed = await this.#refreshState(thread, { emitChange: false });
		thread = this.#liveByTarget(thread.id);
		const mode = command.mode ?? defaultSendMode(thread.phase);
		const sendAcceptanceBaseline = captureSendAcceptanceBaseline(thread, {
			allowActivityFastPath: refreshed,
		});
		const response = await sendMessage(thread, mode, command.message);
		if (response.success) {
			const current = this.#threads.get(thread.id);
			if (current?.state === "live") {
				recordAcceptedSend(current, sendAcceptanceBaseline);
			}
		}
		this.#emitChange();

		return {
			kind: "sent",
			mode,
			accepted: response.success,
			error: response.success ? null : (response.error ?? "Message was rejected by child Pi."),
			...snapshotPair(this.#required(thread.id)),
		};
	}

	async stop(command: StopCommand): Promise<StopOutcome> {
		let thread = this.#requiredByTarget(command.id);
		const id = thread.id;

		if (thread.state === "closed") return { kind: "stopped", ...snapshotPair(thread) };
		if (thread.session.kind !== "known") await this.#refreshSession(thread);

		thread = this.#required(id);
		if (thread.state === "closed") return { kind: "stopped", ...snapshotPair(thread) };

		thread.stopRequested = true;
		thread.phase = "stopping";
		appendThreadEvent(thread, { type: "thread_stopping" });
		this.#emitChange();

		if (command.force === true) {
			thread.child.kill("SIGKILL");
		} else {
			await thread.rpc.request({ type: "abort" }, RPC_QUICK_TIMEOUT_MS).catch(() => undefined);
			thread.child.kill("SIGTERM");
			await delay(STOP_GRACE_MS);
			if (this.#threads.get(id)?.state === "live") thread.child.kill("SIGKILL");
		}

		await Promise.race([thread.closed, delay(STOP_GRACE_MS)]);
		this.#emitChange();
		return { kind: "stopped", ...snapshotPair(this.#required(id)) };
	}

	async wait(command: WaitCommand, options: WaitOptions = {}): Promise<WaitOutcome> {
		const startedAt = Date.now();
		const timeoutMs = normalizeWaitTimeoutMs(command.timeoutMs);
		throwIfAborted(options.signal);
		const id = this.#requiredByTarget(command.id).id;

		for (;;) {
			throwIfAborted(options.signal);
			const thread = this.#required(id);
			if (thread.state === "closed") {
				return {
					kind: "waited",
					timedOut: false,
					waitedMs: Date.now() - startedAt,
					...snapshotPair(thread),
				};
			}

			const remainingBeforeRefresh = timeoutMs - (Date.now() - startedAt);
			if (remainingBeforeRefresh <= 0) {
				return {
					kind: "waited",
					timedOut: true,
					waitedMs: Date.now() - startedAt,
					...snapshotPair(thread),
				};
			}

			let refreshedFromChild = false;
			if (thread.state === "live") {
				// eslint-disable-next-line no-await-in-loop -- wait intentionally observes one thread over time.
				refreshedFromChild = await abortable(
					this.#refreshState(thread, {
						timeoutMs: Math.min(RPC_QUICK_TIMEOUT_MS, remainingBeforeRefresh),
					}),
					options.signal,
				);
			}

			const refreshed = this.#required(id);
			emitWaitProgress(options, startedAt, refreshed);
			if (
				refreshed.state === "closed" ||
				(refreshedFromChild && refreshed.phase === "idle" && hasNoPendingMessages(refreshed))
			) {
				return {
					kind: "waited",
					timedOut: false,
					waitedMs: Date.now() - startedAt,
					...snapshotPair(refreshed),
				};
			}

			const elapsedMs = Date.now() - startedAt;
			const remainingMs = timeoutMs - elapsedMs;
			if (remainingMs <= 0) {
				return {
					kind: "waited",
					timedOut: true,
					waitedMs: elapsedMs,
					...snapshotPair(refreshed),
				};
			}

			const sleepMs = Math.min(WAIT_POLL_INTERVAL_MS, remainingMs);
			if (refreshed.state === "live") {
				// eslint-disable-next-line no-await-in-loop -- wait intentionally sleeps between status checks.
				await Promise.race([refreshed.closed, delay(sleepMs, options.signal)]);
			} else {
				// eslint-disable-next-line no-await-in-loop -- wait intentionally sleeps between status checks.
				await delay(sleepMs, options.signal);
			}
		}
	}

	async shutdown(): Promise<void> {
		const liveThreads = Array.from(this.#threads.values()).filter(
			(thread): thread is LiveThread => thread.state === "live",
		);
		await Promise.all(
			liveThreads.map(async (thread) => {
				thread.stopRequested = true;
				thread.child.kill("SIGTERM");
				await Promise.race([thread.closed, delay(STOP_KILL_WAIT_MS)]);
				if (this.#threads.get(thread.id)?.state === "live") {
					thread.child.kill("SIGKILL");
					await Promise.race([thread.closed, delay(STOP_KILL_WAIT_MS)]);
				}
			}),
		);
		this.#emitChange();
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
		if (!thread) throw this.#unknownThreadReferenceError(id);
		return thread;
	}

	#requiredByTarget(target: string): ManagedThread {
		return this.#required(this.#resolveTarget(target));
	}

	#liveByTarget(target: string): LiveThread {
		const thread = this.#requiredByTarget(target);
		if (thread.state === "closed") throw new Error(`Thread is closed: ${target}`);
		return thread;
	}

	#resolveTarget(targetText: string): ThreadId {
		const target = targetText.trim();
		if (isThreadIdText(target)) {
			const id = asThreadId(target);
			if (this.#threads.has(id)) return id;
			throw this.#unknownThreadReferenceError(targetText);
		}

		const pathReference = this.#tryResolvePathReference(target);
		if (pathReference !== null) {
			const thread = Array.from(this.#threads.values()).find(
				(candidate) => candidate.path === pathReference,
			);
			if (thread) return thread.id;
		}

		const matches = Array.from(this.#threads.values()).filter(
			(thread) =>
				thread.taskName === target ||
				threadPathBasename(thread.path) === target ||
				thread.name === target,
		);
		if (matches.length === 1) return matches[0]!.id;
		if (matches.length > 1) {
			throw new Error(
				`Ambiguous thread reference "${targetText}". Candidate paths: ${matches
					.map((thread) => thread.path)
					.join(", ")}. Repair: use one of the candidate paths or a thread id instead.`,
			);
		}

		throw this.#unknownThreadReferenceError(targetText);
	}

	#resolveListPathReference(reference: string): ThreadPath {
		const trimmed = reference.trim();
		if (trimmed === "." || trimmed === "self") return this.#currentPath;
		if (isThreadIdText(trimmed)) {
			const id = asThreadId(trimmed);
			if (this.#selfThreadId === id) return this.#currentPath;
			const thread = this.#threads.get(id);
			if (thread !== undefined) return thread.path;
			throw this.#unknownThreadReferenceError(reference);
		}

		const pathReference = this.#tryResolvePathReference(reference);
		// List filters only compare stored parentPath/path prefixes, so a syntactically
		// valid path is useful even when no managed thread exists at that exact path.
		if (pathReference !== null) return pathReference;

		const thread = this.#requiredByTarget(reference);
		return thread.path;
	}

	#tryResolvePathReference(referenceText: string): ThreadPath | null {
		const reference = referenceText.trim();
		try {
			if (reference.startsWith("/")) return asThreadPath(reference);
			if (reference.startsWith("root/")) return asThreadPath(`/${reference}`);
			if (reference.includes("/")) return asThreadPath(`${this.#currentPath}/${reference}`);
			return joinThreadPath(this.#currentPath, reference);
		} catch {
			return null;
		}
	}

	#generateUniqueTaskName(command: StartCommand, id: ThreadId): string {
		const base =
			taskNameFromText(command.name) ?? taskNameFromText(command.prompt) ?? shortTaskName(id);
		return this.#uniqueTaskName(base, id);
	}

	#uniqueTaskName(base: string, id: ThreadId): string {
		for (let attempt = 1; attempt <= 10_000; attempt += 1) {
			const candidate = taskNameWithNumericSuffix(base, attempt);
			if (this.#findByPath(joinThreadPath(this.#currentPath, candidate)) === undefined) {
				return candidate;
			}
		}

		const idBase = assertTaskName(id);
		for (let attempt = 1; attempt <= 100; attempt += 1) {
			const candidate = taskNameWithNumericSuffix(idBase, attempt);
			if (this.#findByPath(joinThreadPath(this.#currentPath, candidate)) === undefined) {
				return candidate;
			}
		}

		throw new Error(
			`Unable to generate a unique taskName under ${this.#currentPath}. Repair: provide an explicit unique start.taskName.`,
		);
	}

	#findByPath(threadPath: ThreadPath): ManagedThread | undefined {
		return Array.from(this.#threads.values()).find((thread) => thread.path === threadPath);
	}

	#assertPathAvailable(threadPath: ThreadPath): void {
		const existing = this.#findByPath(threadPath);
		if (existing) {
			throw new Error(
				`Thread path already exists: ${threadPath} (id: ${existing.id}). Repair: choose a unique start.taskName for this parent, or omit taskName so pi-threads generates a unique lower_snake_case path segment.`,
			);
		}
	}

	#unknownThreadReferenceError(reference: string): Error {
		const suggestions = knownThreadSuggestions(this.#threads.values());
		const known =
			suggestions.length === 0
				? " No threads are currently managed by this parent."
				: ` Known threads: ${suggestions.join("; ")}.`;
		return new Error(
			`Unknown thread reference: "${reference}". Accepted reference forms: thread id (thread_012345abcdef), canonical path (/root/task), relative path from the current thread (task or parent/task), or unambiguous taskName/name.${known} Repair: use a known path/id, run { "action": "list" }, or start the thread first.`,
		);
	}

	#closeThread(id: ThreadId, exit: ThreadExit): void {
		const thread = this.#threads.get(id);
		if (!thread || thread.state === "closed") return;

		const closed: ClosedThread = {
			state: "closed",
			id: thread.id,
			name: thread.name,
			taskName: thread.taskName,
			path: thread.path,
			parentPath: thread.parentPath,
			parentThreadId: thread.parentThreadId,
			depth: thread.depth,
			cwd: thread.cwd,
			args: thread.args,
			createdAt: thread.createdAt,
			lastEventAt: nowIso(),
			session: thread.session,
			lastAssistantText: thread.lastAssistantText,
			recentEvents: thread.recentEvents,
			nextEventSeq: thread.nextEventSeq,
			stderrTail: thread.stderrTail,
			exit,
		};

		appendThreadEvent(closed, { type: "thread_closed", exit });
		this.#threads.set(id, closed);
		thread.resolveClosed();
		this.#emitChange();
	}

	#recordInitialPromptResponse(id: ThreadId, response: RpcResponse): boolean {
		const thread = this.#threads.get(id);
		if (thread?.state !== "live") return false;

		const pending = thread.pendingInitialPrompt;
		if (pending === null || response.id !== pending.requestId) return false;

		thread.pendingInitialPrompt = null;
		if (response.success) {
			recordAcceptedInitialPrompt(thread);
		} else if (thread.phase === "starting") {
			thread.phase = "idle";
		}
		return true;
	}

	#handleRpcEvent(id: ThreadId, clientEvent: RpcClientEvent): void {
		const thread = this.#threads.get(id);
		if (!thread || thread.state === "closed") return;

		thread.lastEventAt = nowIso();

		if (clientEvent.kind === "parse_error") {
			appendThreadEvent(thread, { type: "thread_error", message: clientEvent.message });
			this.#emitChange();
			return;
		}

		if (clientEvent.kind === "response") {
			if (this.#recordInitialPromptResponse(id, clientEvent.response)) this.#emitChange();
			return;
		}

		const event = clientEvent.event;
		const type = stringField(event, "type");
		switch (type) {
			case "agent_start": {
				recordPromptRunActivity(thread);
				thread.phase = "busy";
				thread.hasRun = true;
				recordThreadTurnStarted(thread);
				this.#emitChange();
				return;
			}
			case "agent_end": {
				recordPromptRunActivity(thread);
				thread.phase = "idle";
				thread.lastPartialText = null;
				allowAwaitingSendRunActivity(thread);
				clearObservedSendIfIdle(thread);
				recordThreadTurnCompleted(thread);
				this.#emitChange();
				return;
			}
			case "turn_start": {
				recordPromptRunActivity(thread);
				thread.phase = "busy";
				thread.hasRun = true;
				recordThreadTurnStarted(thread);
				this.#emitChange();
				return;
			}
			case "message_start": {
				recordPromptRunActivity(thread);
				if (isUserMessage(event["message"])) thread.userMessageStartGeneration++;
				thread.phase = "busy";
				thread.hasRun = true;
				recordThreadTurnStarted(thread);
				this.#emitChange();
				return;
			}
			case "turn_end": {
				recordPromptRunActivity(thread);
				allowAwaitingSendRunActivity(thread);
				recordThreadTurnCompleted(thread);
				this.#emitChange();
				return;
			}
			case "message_update": {
				recordPromptRunActivity(thread);
				const text = extractAssistantText(event["message"]);
				if (text !== null) thread.lastPartialText = text;
				return;
			}
			case "message_end": {
				recordPromptRunActivity(thread);
				const text = extractAssistantText(event["message"]);
				if (text !== null) {
					thread.lastAssistantText = text;
					thread.lastPartialText = null;
					clearObservedSendIfIdle(thread);
					appendThreadEvent(thread, { type: "assistant_message", text: tail(text, 2_000) });
					this.#emitChange();
				}
				return;
			}
			case "tool_execution_start": {
				recordPromptRunActivity(thread);
				thread.phase = "busy";
				recordThreadTurnStarted(thread);
				appendThreadEvent(thread, {
					type: "tool_started",
					toolName: stringField(event, "toolName") ?? "unknown",
				});
				this.#emitChange();
				return;
			}
			case "tool_execution_update": {
				recordPromptRunActivity(thread);
				return;
			}
			case "tool_execution_end": {
				recordPromptRunActivity(thread);
				appendThreadEvent(thread, {
					type: "tool_completed",
					toolName: stringField(event, "toolName") ?? "unknown",
					error: event["isError"] === true,
				});
				this.#emitChange();
				return;
			}
			case "extension_ui_request": {
				recordSendActivity(thread);
				const requestId = stringField(event, "id");
				const method = stringField(event, "method") ?? "unknown";
				const shouldAutoCancel = requestId !== null && isDialogUiMethod(method);
				appendThreadEvent(thread, {
					type: "ui_request",
					method,
					title: stringField(event, "title"),
					autoCancelled: shouldAutoCancel,
				});
				if (shouldAutoCancel) thread.rpc.respondToUiRequest(requestId);
				this.#emitChange();
				return;
			}
			default:
				return;
		}
	}

	async #requestState(
		thread: LiveThread,
		options: { readonly recordErrors: boolean; readonly timeoutMs?: number },
	): Promise<Record<string, unknown> | null> {
		const response = await thread.rpc
			.request({ type: "get_state" }, options.timeoutMs ?? RPC_QUICK_TIMEOUT_MS)
			.catch((error: unknown) => {
				if (options.recordErrors) {
					appendThreadEvent(thread, {
						type: "thread_error",
						message: error instanceof Error ? error.message : String(error),
					});
				}
				return null;
			});

		if (!response?.success || !isRecord(response.data)) return null;
		return response.data;
	}

	async #refreshSession(thread: LiveThread): Promise<void> {
		const data = await this.#requestState(thread, { recordErrors: false });
		if (data === null) return;
		if (captureSession(thread, data)) this.#emitChange();
	}

	async #refreshState(
		thread: LiveThread,
		options: { readonly emitChange?: boolean; readonly timeoutMs?: number } = { emitChange: true },
	): Promise<boolean> {
		const requestOptions =
			options.timeoutMs === undefined
				? { recordErrors: true }
				: { recordErrors: true, timeoutMs: options.timeoutMs };
		const data = await this.#requestState(thread, requestOptions);
		if (data === null) return false;

		captureSession(thread, data);

		const isStreaming = data["isStreaming"] === true;
		const isCompacting = data["isCompacting"] === true;
		const pendingMessageCount = numberField(data, "pendingMessageCount");
		const hasPendingMessages = pendingMessageCount !== null && pendingMessageCount !== 0;
		const hasRunActivity = isStreaming || isCompacting;
		const childAppearsIdle = !hasRunActivity && !hasPendingMessages;
		if (hasRunActivity) {
			thread.hasRun = true;
			recordPromptRunActivity(thread);
		}
		if (hasPendingMessages) {
			clearPendingInitialPrompt(thread);
			recordPendingMessageActivity(thread, pendingMessageCount);
		}
		if (thread.phase !== "stopping") {
			if (isStreaming || isCompacting || hasPendingMessages) {
				thread.phase = "busy";
			} else if (thread.awaitingSend !== null) {
				// A successful prompt can be fully handled without starting an agent turn
				// (for example slash commands or extension input handlers). Once a fresh
				// state read confirms there is no streaming/compaction/queue activity, the
				// accepted send can settle even if no agent events were emitted. The initial
				// prompt is different: a prompt response only confirms acceptance, and the
				// first agent events can arrive asynchronously after an idle-looking state
				// read, so it must stay busy until activity is observed. Sends accepted
				// while another turn was already busy require one extra idle confirmation so
				// a previous turn ending is not mistaken for new-send work.
				allowAwaitingSendRunActivity(thread);
				if (thread.awaitingSend.observedActivity) {
					thread.phase = "idle";
					clearObservedSendIfIdle(thread);
				} else if (thread.awaitingSend.requireObservedActivity) {
					thread.phase = "busy";
				} else {
					thread.awaitingSend.idleRefreshCount++;
					if (thread.awaitingSend.idleRefreshCount >= thread.awaitingSend.idleRefreshesToSettle) {
						thread.awaitingSend = null;
						thread.phase = "idle";
					} else {
						thread.phase = "busy";
					}
				}
			} else if (
				thread.phase !== "starting" ||
				thread.hasRun ||
				thread.lastAssistantText !== null
			) {
				thread.phase = "idle";
			}
		}
		if (childAppearsIdle && thread.phase !== "stopping") recordThreadTurnCompleted(thread);
		if (options.emitChange ?? true) this.#emitChange();
		return true;
	}

	#emitChange(): void {
		if (this.#listeners.size === 0) return;
		const threads = Array.from(this.#threads.values())
			.toSorted((left, right) => left.path.localeCompare(right.path))
			.map((thread) => snapshot(thread));
		for (const listener of this.#listeners) {
			try {
				listener(threads);
			} catch {
				// UI observers must not affect thread lifecycle management.
			}
		}
	}
}

function captureSession(thread: LiveThread, data: Record<string, unknown>): boolean {
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

		const changed =
			thread.session.kind !== "known" ||
			thread.session.file !== nextSession.file ||
			thread.session.id !== nextSession.id ||
			thread.session.name !== nextSession.name ||
			thread.session.pendingMessageCount !== nextSession.pendingMessageCount;
		thread.session = nextSession;
		return changed;
	}

	return false;
}

export function buildPiArgs(input: {
	readonly name: string;
	readonly extraArgs: readonly string[];
	readonly inheritedArgs?: readonly string[];
	readonly projectTrusted: boolean;
}): readonly string[] {
	const childArgs = mergeChildArgs(input.inheritedArgs ?? [], input.extraArgs);
	return [
		...childArgs,
		"--mode",
		"rpc",
		"--name",
		input.name,
		input.projectTrusted ? "--approve" : "--no-approve",
	] as const;
}

type CliFlagSpec = {
	readonly canonical: string;
	readonly takesValue: boolean;
	readonly allowExtra: boolean;
	readonly inherit: boolean;
	readonly valueKind?: "cli-path";
};

const CLI_FLAG_SPECS = new Map<string, CliFlagSpec>(
	[
		flagSpec(["--provider"], { takesValue: true, allowExtra: true, inherit: true }),
		flagSpec(["--model"], { takesValue: true, allowExtra: true, inherit: true }),
		flagSpec(["--models"], { takesValue: true, allowExtra: true, inherit: true }),
		flagSpec(["--thinking"], { takesValue: true, allowExtra: true, inherit: true }),
		flagSpec(["--exclude-tools", "-xt"], {
			takesValue: true,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--no-tools", "-nt"], { takesValue: false, allowExtra: true, inherit: true }),
		flagSpec(["--no-builtin-tools", "-nbt"], {
			takesValue: false,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--offline"], { takesValue: false, allowExtra: true, inherit: true }),
		flagSpec(["--no-extensions", "-ne"], {
			takesValue: false,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--no-skills", "-ns"], { takesValue: false, allowExtra: true, inherit: true }),
		flagSpec(["--no-prompt-templates", "-np"], {
			takesValue: false,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--no-themes"], { takesValue: false, allowExtra: true, inherit: true }),
		flagSpec(["--no-context-files", "-nc"], {
			takesValue: false,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--tools", "-t"], { takesValue: true, allowExtra: false, inherit: true }),
		flagSpec(["--extension", "-e"], {
			takesValue: true,
			allowExtra: false,
			inherit: true,
			valueKind: "cli-path",
		}),
		flagSpec(["--skill"], {
			takesValue: true,
			allowExtra: false,
			inherit: true,
			valueKind: "cli-path",
		}),
		flagSpec(["--prompt-template"], {
			takesValue: true,
			allowExtra: false,
			inherit: true,
			valueKind: "cli-path",
		}),
		flagSpec(["--theme"], {
			takesValue: true,
			allowExtra: false,
			inherit: true,
			valueKind: "cli-path",
		}),
	].flat(),
);

const VALUE_FLAGS_TO_SKIP = new Set([
	"--api-key",
	"--append-system-prompt",
	"--export",
	"--fork",
	"--mode",
	"--name",
	"-n",
	"--session",
	"--session-dir",
	"--session-id",
	"--system-prompt",
]);

const OPTIONAL_VALUE_FLAGS_TO_SKIP = new Set(["--list-models"]);

const SENSITIVE_BOOLEAN_FLAGS = new Set([
	"--approve",
	"-a",
	"--continue",
	"-c",
	"--help",
	"-h",
	"--no-approve",
	"-na",
	"--print",
	"-p",
	"--resume",
	"-r",
	"--verbose",
	"--version",
	"-v",
]);

const PACKAGE_SUBCOMMANDS = new Set(["config", "install", "list", "remove", "uninstall", "update"]);
const NO_TOOLS_FLAGS = new Set(["--no-tools", "-nt"]);
const NO_BUILTIN_TOOLS_FLAGS = new Set(["--no-builtin-tools", "-nbt"]);
const NO_EXTENSIONS_FLAGS = new Set(["--no-extensions", "-ne"]);
const NO_SKILLS_FLAGS = new Set(["--no-skills", "-ns"]);
const NO_PROMPT_TEMPLATES_FLAGS = new Set(["--no-prompt-templates", "-np"]);
const NO_THEMES_FLAGS = new Set(["--no-themes"]);
const TOOLS_FLAGS = new Set(["--tools", "-t"]);
const EXTENSION_FLAGS = new Set(["--extension", "-e"]);
const SKILL_FLAGS = new Set(["--skill"]);
const PROMPT_TEMPLATE_FLAGS = new Set(["--prompt-template"]);
const THEME_FLAGS = new Set(["--theme"]);
const EXCLUDE_TOOLS_FLAGS = new Set(["--exclude-tools", "-xt"]);
const MODEL_SCOPE_FLAGS = new Set(["--models"]);
const ALLOWED_EXTRA_ARGS_HELP =
	"allowed start.args are safe narrowing flags such as --provider <value>, --model <value>, --models <value>, --thinking <value>, --exclude-tools <value>, --no-tools, --no-builtin-tools, --offline, --no-extensions, --no-skills, --no-prompt-templates, --no-themes, and --no-context-files";
// Pi applies --thinking after scoped model thinking, so it can widen an inherited
// --models scope just like selecting a different model/provider can.
const MODEL_SCOPE_OVERRIDE_FLAGS = new Set(["--provider", "--model", "--models", "--thinking"]);
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const INHERITED_ENABLE_RESTRICTIONS: readonly {
	readonly restrictionFlags: ReadonlySet<string>;
	readonly enableFlags: ReadonlySet<string>;
}[] = [
	{ restrictionFlags: NO_TOOLS_FLAGS, enableFlags: TOOLS_FLAGS },
	{ restrictionFlags: NO_EXTENSIONS_FLAGS, enableFlags: EXTENSION_FLAGS },
	{ restrictionFlags: NO_SKILLS_FLAGS, enableFlags: SKILL_FLAGS },
	{ restrictionFlags: NO_PROMPT_TEMPLATES_FLAGS, enableFlags: PROMPT_TEMPLATE_FLAGS },
	{ restrictionFlags: NO_THEMES_FLAGS, enableFlags: THEME_FLAGS },
];

export function assertAllowedExtraArgs(args: readonly string[]): void {
	parseAllowedExtraArgs(args);
}

export function collectInheritedPiArgs(
	argv: readonly string[] = process.argv,
	resourceBaseCwd: string = process.cwd(),
): readonly string[] {
	const args = processArgvToPiArgs(argv);
	const inherited: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--") break;

		// Pi's built-in parser only recognizes value flags in `--flag value` form.
		// Inline assignments such as `--model=opus` are exposed as extension
		// unknownFlags instead, so reinterpreting them here would make child Pi
		// processes inherit settings the parent did not actually apply.
		if (arg.includes("=")) {
			continue;
		}

		const spec = CLI_FLAG_SPECS.get(arg);
		if (spec?.inherit === true) {
			if (spec.takesValue) {
				const value = args[i + 1];
				if (value !== undefined) {
					inherited.push(spec.canonical, normalizeInheritedValue(spec, value, resourceBaseCwd));
					i++;
				}
			} else {
				inherited.push(spec.canonical);
			}
			continue;
		}

		if (VALUE_FLAGS_TO_SKIP.has(arg) && i + 1 < args.length) {
			i++;
			continue;
		}

		if (
			OPTIONAL_VALUE_FLAGS_TO_SKIP.has(arg) &&
			i + 1 < args.length &&
			!isFlagLike(args[i + 1]!) &&
			!args[i + 1]!.startsWith("@")
		) {
			i++;
			continue;
		}

		if (SENSITIVE_BOOLEAN_FLAGS.has(arg)) continue;

		if (arg.startsWith("--") && !arg.includes("=")) {
			const next = args[i + 1];
			if (next !== undefined && !isFlagLike(next) && !next.startsWith("@")) i++;
		}
	}

	return inherited;
}

function normalizeInheritedValue(
	spec: CliFlagSpec,
	value: string,
	resourceBaseCwd: string,
): string {
	if (spec.valueKind !== "cli-path" || !isLocalCliPath(value)) return value;
	return resolveCliPath(value, resourceBaseCwd);
}

function isLocalCliPath(value: string): boolean {
	const trimmed = value.trim();
	return !(
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	);
}

function resolveCliPath(value: string, resourceBaseCwd: string): string {
	const normalized = normalizeCliPath(value);
	const normalizedResourceBaseCwd = normalizeCliPath(resourceBaseCwd);
	return path.isAbsolute(normalized)
		? path.resolve(normalized)
		: path.resolve(normalizedResourceBaseCwd, normalized);
}

function normalizeCliPath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return path.join(os.homedir(), value.slice(2));
	}
	if (value.startsWith("file://")) return fileURLToPath(value);
	return value;
}

export function shouldApproveChildCwd(
	parentProjectTrusted: boolean,
	parentCwd: string,
	childCwd: string,
): boolean {
	return parentProjectTrusted && isCwdInsideOrEqual(parentCwd, childCwd);
}

export function isCwdInsideOrEqual(parentCwd: string, childCwd: string): boolean {
	const parent = realpathOrResolve(parentCwd);
	const child = realpathOrResolve(childCwd);
	const relative = path.relative(parent, child);
	return relative === "" || (!escapesToParent(relative) && !path.isAbsolute(relative));
}

function escapesToParent(relativePath: string): boolean {
	return relativePath === ".." || relativePath.startsWith(`..${path.sep}`);
}

function realpathOrResolve(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function flagSpec(
	aliases: readonly [string, ...string[]],
	options: Omit<CliFlagSpec, "canonical">,
): readonly (readonly [string, CliFlagSpec])[] {
	const canonical = aliases[0];
	return aliases.map((alias) => [alias, { canonical, ...options }] as const);
}

function parseAllowedExtraArgs(args: readonly string[]): readonly string[] {
	const allowed: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg.includes("=")) {
			throw new Error(
				`Unsupported child Pi arg for pi-threads: ${arg}. Repair: inline --flag=value forms are not allowed; pass flag and value as separate array items, e.g. "args": ["--model", "sonnet"].`,
			);
		}
		if (arg === "--" || PACKAGE_SUBCOMMANDS.has(arg) || !isFlagLike(arg)) {
			throw new Error(
				`Unsupported child Pi arg for pi-threads: ${arg}. Repair: remove package subcommands, prompts, and positional args; ${ALLOWED_EXTRA_ARGS_HELP}.`,
			);
		}

		const spec = CLI_FLAG_SPECS.get(arg);
		if (spec?.allowExtra !== true) {
			throw new Error(
				`Unsupported child Pi arg for pi-threads: ${arg}. Repair: remove this flag or replace it with an allowlisted restriction; ${ALLOWED_EXTRA_ARGS_HELP}. Children always run in RPC mode and cannot set session, approval, extension-loading, or one-shot flags through start.args.`,
			);
		}

		allowed.push(arg);
		if (spec.takesValue) {
			const value = args[i + 1];
			if (value === undefined || isFlagLike(value)) {
				throw new Error(
					`Unsupported child Pi arg for pi-threads: ${arg} requires a value. Repair: pass the value as the next array item, e.g. "args": ["${arg}", "value"].`,
				);
			}
			allowed.push(value);
			i++;
		}
	}

	return allowed;
}

function mergeChildArgs(
	inheritedArgs: readonly string[],
	extraArgs: readonly string[],
): readonly string[] {
	const allowedExtraArgs = parseAllowedExtraArgs(extraArgs);
	assertNoInheritedModelScopeOverride(inheritedArgs, allowedExtraArgs);
	const filteredInheritedArgs = stripInheritedEnablesForRestrictions(
		inheritedArgs,
		allowedExtraArgs,
	);

	const childExcludeToolValues = collectFlagValues(allowedExtraArgs, EXCLUDE_TOOLS_FLAGS);
	if (childExcludeToolValues.length > 0) {
		const inheritedExcludeToolValue = collectLastFlagValue(
			filteredInheritedArgs,
			EXCLUDE_TOOLS_FLAGS,
		);
		const mergedExcludeTools = mergeCommaSeparatedValues([
			...(inheritedExcludeToolValue === undefined ? [] : [inheritedExcludeToolValue]),
			...childExcludeToolValues,
		]);
		const argsWithoutInheritedExcludeTools = removeFlags(
			filteredInheritedArgs,
			EXCLUDE_TOOLS_FLAGS,
		);
		const argsWithoutChildExcludeTools = removeFlags(allowedExtraArgs, EXCLUDE_TOOLS_FLAGS);
		return mergedExcludeTools.length === 0
			? [...argsWithoutInheritedExcludeTools, ...argsWithoutChildExcludeTools]
			: [
					...argsWithoutInheritedExcludeTools,
					...argsWithoutChildExcludeTools,
					"--exclude-tools",
					mergedExcludeTools.join(","),
				];
	}

	return [...filteredInheritedArgs, ...allowedExtraArgs];
}

function stripInheritedEnablesForRestrictions(
	inheritedArgs: readonly string[],
	restrictionArgs: readonly string[],
): readonly string[] {
	let filteredArgs = inheritedArgs;
	for (const restriction of INHERITED_ENABLE_RESTRICTIONS) {
		if (hasFlag(restrictionArgs, restriction.restrictionFlags)) {
			filteredArgs = removeFlags(filteredArgs, restriction.enableFlags);
		}
	}
	if (
		!hasFlag(restrictionArgs, NO_TOOLS_FLAGS) &&
		hasFlag(restrictionArgs, NO_BUILTIN_TOOLS_FLAGS)
	) {
		filteredArgs = filterInheritedToolAllowlistForNoBuiltinTools(filteredArgs);
	}
	return filteredArgs;
}

function assertNoInheritedModelScopeOverride(
	inheritedArgs: readonly string[],
	allowedExtraArgs: readonly string[],
): void {
	if (!hasFlag(inheritedArgs, MODEL_SCOPE_FLAGS)) return;
	if (!hasFlag(allowedExtraArgs, MODEL_SCOPE_OVERRIDE_FLAGS)) return;

	throw new Error(
		"Unsupported child Pi arg for pi-threads: child model/provider/thinking args cannot override an inherited --models scope. Repair: omit --provider/--model/--models/--thinking from start.args or start the parent with a narrower model scope.",
	);
}

function filterInheritedToolAllowlistForNoBuiltinTools(
	inheritedArgs: readonly string[],
): readonly string[] {
	// --tools is an active-tool allowlist and can re-enable built-ins even when
	// --no-builtin-tools is present. Intersect the effective inherited allowlist
	// with the child's no-built-ins restriction; if nothing remains, force no
	// tools rather than dropping --tools and enabling every extension tool.
	const inheritedToolValue = collectLastFlagValue(inheritedArgs, TOOLS_FLAGS);
	if (inheritedToolValue === undefined) return inheritedArgs;

	const argsWithoutInheritedTools = removeFlags(inheritedArgs, TOOLS_FLAGS);
	const nonBuiltinTools = mergeCommaSeparatedValues([inheritedToolValue]).filter(
		(toolName) => !BUILTIN_TOOL_NAMES.has(toolName),
	);
	return nonBuiltinTools.length === 0
		? [...argsWithoutInheritedTools, "--no-tools"]
		: [...argsWithoutInheritedTools, "--tools", nonBuiltinTools.join(",")];
}

function hasFlag(args: readonly string[], flags: ReadonlySet<string>): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (flags.has(arg)) return true;

		const spec = CLI_FLAG_SPECS.get(arg);
		if (spec?.takesValue === true) i++;
	}
	return false;
}

function collectFlagValues(args: readonly string[], flags: ReadonlySet<string>): readonly string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;

		const spec = CLI_FLAG_SPECS.get(arg);
		if (flags.has(arg)) {
			const value = args[i + 1];
			if (spec?.takesValue === true && value !== undefined) {
				values.push(value);
				i++;
			}
			continue;
		}

		if (spec?.takesValue === true) i++;
	}
	return values;
}

function collectLastFlagValue(
	args: readonly string[],
	flags: ReadonlySet<string>,
): string | undefined {
	let value: string | undefined;
	for (const nextValue of collectFlagValues(args, flags)) value = nextValue;
	return value;
}

function mergeCommaSeparatedValues(values: readonly string[]): readonly string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		for (const item of value.split(",")) {
			const normalized = item.trim();
			if (normalized === "" || seen.has(normalized)) continue;
			seen.add(normalized);
			merged.push(normalized);
		}
	}
	return merged;
}

function removeFlags(args: readonly string[], flags: ReadonlySet<string>): readonly string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		const spec = CLI_FLAG_SPECS.get(arg);
		if (!flags.has(arg)) {
			result.push(arg);
			if (spec?.takesValue === true) {
				const value = args[i + 1];
				if (value !== undefined) {
					result.push(value);
					i++;
				}
			}
			continue;
		}

		if (spec?.takesValue === true) i++;
	}
	return result;
}

function processArgvToPiArgs(argv: readonly string[]): readonly string[] {
	if (argv.length <= 1) return [];
	const invokedScript = argv[1];
	if (invokedScript !== undefined && looksLikeNodeScript(invokedScript)) return argv.slice(2);
	const execName = path.basename(argv[0] ?? "").toLowerCase();
	if (/^(node|bun)(\.exe)?$/u.test(execName)) return argv.slice(2);
	return argv.slice(1);
}

function looksLikeNodeScript(value: string): boolean {
	return (
		value.endsWith(".js") ||
		value.endsWith(".mjs") ||
		value.endsWith(".cjs") ||
		value.endsWith(".ts") ||
		value.startsWith("/$bunfs/root/") ||
		fs.existsSync(value)
	);
}

function isFlagLike(value: string): boolean {
	return value.startsWith("-") && !value.startsWith("---");
}

function snapshotPair(thread: ManagedThread): {
	readonly thread: ThreadSnapshot;
	readonly snapshot: ThreadRuntimeSnapshot;
} {
	const threadSnapshot = snapshot(thread);
	return { thread: threadSnapshot, snapshot: toThreadRuntimeSnapshot(threadSnapshot) };
}

function normalizeWaitTimeoutMs(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
	if (Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= MAX_WAIT_TIMEOUT_MS) {
		return timeoutMs;
	}

	throw new Error(
		`Invalid wait timeoutMs: ${timeoutMs}. Repair: set wait.timeoutMs to an integer from 0 to ${MAX_WAIT_TIMEOUT_MS}, or omit it to use ${DEFAULT_WAIT_TIMEOUT_MS}ms.`,
	);
}

function taskNameFromText(value: string | undefined): string | null {
	if (value === undefined) return null;
	const normalized = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "_")
		.replace(/_+/gu, "_")
		.replace(/^_+|_+$/gu, "");
	if (normalized === "") return null;
	return assertTaskName(truncateTaskName(normalized));
}

function taskNameWithNumericSuffix(base: string, attempt: number): string {
	const suffix = attempt === 1 ? "" : `_${attempt}`;
	const stemMaxLength = TASK_NAME_MAX_LENGTH - suffix.length;
	if (stemMaxLength < 1) throw new Error(`Unable to generate taskName suffix: ${suffix}`);
	const stem = truncateTaskName(base, stemMaxLength);
	return assertTaskName(`${stem}${suffix}`);
}

function truncateTaskName(value: string, maxLength = TASK_NAME_MAX_LENGTH): string {
	const truncated = value.slice(0, maxLength).replace(/_+$/u, "");
	return truncated === "" ? value.slice(0, maxLength) : truncated;
}

function generateDisplayName(prompt: string, taskName: string, id: ThreadId): string {
	return displayNameFromPrompt(prompt) ?? humanizeTaskName(taskName) ?? shortTaskName(id);
}

function displayNameFromPrompt(prompt: string): string | null {
	const firstUsefulLine = prompt
		.split(/\r?\n/u)
		.map((line) => line.replace(/\s+/gu, " ").trim())
		.find((line) => line !== "" && /[\p{L}\p{N}]/u.test(line));
	if (firstUsefulLine === undefined) return null;
	return truncateDisplayName(firstUsefulLine);
}

function truncateDisplayName(value: string): string {
	if (value.length <= DISPLAY_NAME_MAX_LENGTH) return value;
	return `${value.slice(0, DISPLAY_NAME_MAX_LENGTH - 3).trimEnd()}...`;
}

function humanizeTaskName(taskName: string): string | null {
	const text = taskName.replaceAll("_", " ").trim();
	return text === "" ? null : text;
}

function shortTaskName(id: ThreadId): string {
	return assertTaskName(id.slice(0, "thread_".length + 6));
}

function snapshot(thread: ManagedThread): ThreadSnapshot {
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

type ThreadEventInput = ThreadEvent extends infer Event
	? Event extends ThreadEvent
		? Omit<Event, "seq" | "at">
		: never
	: never;

function appendThreadEvent(thread: ThreadBase, event: ThreadEventInput): void {
	const at = nowIso();
	const nextEvent = { ...event, seq: thread.nextEventSeq, at } as ThreadEvent;
	thread.nextEventSeq++;
	thread.lastEventAt = at;
	thread.recentEvents.push(nextEvent);
	if (thread.recentEvents.length > RECENT_EVENT_LIMIT)
		thread.recentEvents.splice(0, thread.recentEvents.length - RECENT_EVENT_LIMIT);
}

function recordThreadTurnStarted(thread: LiveThread): void {
	if (thread.turnOpen) return;
	thread.turnOpen = true;
	appendThreadEvent(thread, { type: "turn_started" });
}

function recordThreadTurnCompleted(thread: LiveThread): void {
	if (!thread.turnOpen) return;
	thread.turnOpen = false;
	appendThreadEvent(thread, { type: "turn_completed" });
}

function resolveCwd(parentCwd: string, childCwd: string | undefined): string {
	const cwd = childCwd === undefined ? path.resolve(parentCwd) : path.resolve(parentCwd, childCwd);
	let stats: fs.Stats;
	try {
		stats = fs.statSync(cwd);
	} catch (error) {
		const reason = error instanceof Error ? ` (${error.message})` : "";
		throw new Error(
			`Invalid child cwd: ${cwd} does not exist or cannot be accessed${reason}. Repair: set start.cwd to an existing directory path, create the directory first, or omit cwd to use the parent session cwd.`,
			{ cause: error },
		);
	}

	if (!stats.isDirectory()) {
		throw new Error(
			`Invalid child cwd: ${cwd} is not a directory. Repair: set start.cwd to an existing directory path, not a file, or omit cwd to use the parent session cwd.`,
		);
	}

	return cwd;
}

function knownThreadSuggestions(threads: Iterable<ManagedThread>): readonly string[] {
	return Array.from(threads)
		.toSorted((left, right) => left.path.localeCompare(right.path))
		.slice(0, 8)
		.map((thread) => `${thread.path} (id: ${thread.id}, taskName: ${thread.taskName})`);
}

function sameSessionFile(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}

function defaultSendMode(phase: ThreadPhase): SendMode {
	return phase === "idle" ? "prompt" : "follow_up";
}

function captureSendAcceptanceBaseline(
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

function recordAcceptedSend(thread: LiveThread, baseline: SendAcceptanceBaseline): void {
	const observedUserMessageStart =
		thread.userMessageStartGeneration > baseline.userMessageStartGeneration;
	const observedActivity =
		observedUserMessageStart ||
		(baseline.allowActivityFastPath && thread.activityGeneration !== baseline.activityGeneration);
	thread.awaitingSend = {
		observedActivity,
		requireObservedActivity: false,
		ignoreRunActivityUntilIdle: !baseline.allowActivityFastPath && thread.phase !== "idle",
		idleRefreshCount: 0,
		idleRefreshesToSettle: baseline.phase === "idle" ? 1 : BUSY_SEND_IDLE_SETTLE_REFRESHES,
		pendingMessageBaseline: baseline.pendingMessageCount,
	};
	if (thread.phase !== "stopping") {
		if (observedActivity && thread.phase === "idle") {
			clearObservedSendIfIdle(thread);
		} else {
			thread.phase = "busy";
		}
	}
}

function recordAcceptedInitialPrompt(thread: LiveThread): void {
	thread.awaitingSend ??= {
		observedActivity: false,
		requireObservedActivity: true,
		ignoreRunActivityUntilIdle: false,
		idleRefreshCount: 0,
		idleRefreshesToSettle: 1,
		pendingMessageBaseline: getPendingMessageCount(thread),
	};
	if (thread.phase !== "stopping") thread.phase = "busy";
}

function recordPromptRunActivity(thread: LiveThread): void {
	clearPendingInitialPrompt(thread);
	recordSendActivity(thread);
}

function clearPendingInitialPrompt(thread: LiveThread): void {
	thread.pendingInitialPrompt = null;
}

function recordSendActivity(thread: LiveThread): void {
	thread.activityGeneration++;
	if (thread.awaitingSend !== null && !thread.awaitingSend.ignoreRunActivityUntilIdle) {
		thread.awaitingSend.observedActivity = true;
	}
}

function allowAwaitingSendRunActivity(thread: LiveThread): void {
	if (thread.awaitingSend !== null) thread.awaitingSend.ignoreRunActivityUntilIdle = false;
}

function recordPendingMessageActivity(thread: LiveThread, pendingMessageCount: number): void {
	const awaitingSend = thread.awaitingSend;
	if (awaitingSend === null || awaitingSend.observedActivity) return;
	const baseline = awaitingSend.pendingMessageBaseline;
	if (baseline === null || pendingMessageCount > baseline) {
		thread.activityGeneration++;
		awaitingSend.observedActivity = true;
		awaitingSend.ignoreRunActivityUntilIdle = false;
	}
}

function clearObservedSendIfIdle(thread: LiveThread): void {
	if (thread.awaitingSend?.observedActivity === true && thread.phase === "idle") {
		thread.awaitingSend = null;
	}
}

function getPendingMessageCount(thread: ManagedThread): number | null {
	return thread.session.kind === "known" ? thread.session.pendingMessageCount : null;
}

function hasNoPendingMessages(thread: ManagedThread): boolean {
	const pendingMessageCount = getPendingMessageCount(thread);
	return pendingMessageCount === null || pendingMessageCount === 0;
}

function emitWaitProgress(options: WaitOptions, startedAt: number, thread: ManagedThread): void {
	options.onProgress?.({ waitedMs: Date.now() - startedAt, ...snapshotPair(thread) });
}

function classifyProcessExit(input: {
	readonly code: number | null;
	readonly signal: string | null;
	readonly stopped: boolean;
}): ThreadExit {
	if (input.stopped) return { kind: "stopped", code: input.code, signal: input.signal };
	if (input.code === 0 && input.signal === null) {
		return { kind: "exited", code: input.code, signal: input.signal };
	}

	const details = [
		input.code === null ? null : `code ${input.code}`,
		input.signal === null ? null : `signal ${input.signal}`,
	]
		.filter((part): part is string => part !== null)
		.join(", ");
	return { kind: "failed", message: `Child Pi process exited with ${details || "unknown status"}` };
}

async function sendMessage(thread: LiveThread, mode: SendMode, message: string) {
	switch (mode) {
		case "prompt":
			return thread.rpc.request({ type: "prompt", message }, RPC_SEND_TIMEOUT_MS);
		case "steer":
			return thread.rpc.request(
				{ type: "prompt", message, streamingBehavior: "steer" },
				RPC_SEND_TIMEOUT_MS,
			);
		case "follow_up":
			return thread.rpc.request(
				{ type: "prompt", message, streamingBehavior: "followUp" },
				RPC_SEND_TIMEOUT_MS,
			);
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

function isUserMessage(message: unknown): boolean {
	return isRecord(message) && message["role"] === "user";
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

function readOptionalThreadId(value: string | undefined): ThreadId | null {
	if (value === undefined || value === "") return null;
	try {
		return asThreadId(value);
	} catch {
		return null;
	}
}

function readThreadPath(value: string | undefined, fallback: ThreadPath): ThreadPath {
	if (value === undefined || value === "") return fallback;
	try {
		return asThreadPath(value);
	} catch {
		return fallback;
	}
}

function isDialogUiMethod(method: string): boolean {
	return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw abortError();
}

function abortError(): Error {
	return new Error("Thread wait aborted");
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return promise;
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(abortError());
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted === true) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
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
