import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ROOT_THREAD_PATH,
	asThreadPath,
	asThreadId,
	assertTaskName,
	joinThreadPath,
	newThreadId,
	nowIso,
	type ClosedThreadSnapshot,
	type KnownThreadSession,
	type LiveThreadSnapshot,
	type ThreadEvent,
	type ThreadExit,
	type ThreadId,
	type ThreadPath,
	type ThreadSnapshot,
	type ThreadRuntimeSnapshot,
	type ThreadPhase,
	type ThreadSession,
	toThreadRuntimeSnapshot,
} from "./domain.ts";
import {
	assertAllowedExtraArgs,
	buildPiArgs,
	collectInheritedPiArgs,
	shouldApproveChildCwd,
} from "./arg-policy.ts";
import { isRecord, numberField, stringField } from "./json.ts";
import {
	generateDisplayName,
	shortTaskName,
	taskNameFromText,
	taskNameWithNumericSuffix,
} from "./naming.ts";
import { RpcClient, type RpcClientEvent, type RpcResponse } from "./rpc.ts";
import {
	registryScope,
	registryTruncatedTextMatchesFull,
	restoreDurableThreadData,
	restoredThreadRegistrySession,
	threadRegistrySessionsMatch,
	truncateSnapshotForRegistry,
	type DurableThreadData,
	type ThreadRegistryPersistence,
	type ThreadRegistryRestoreScope,
	type ThreadRegistrySession,
	type ThreadRegistryPersistenceTarget,
} from "./thread-registry.ts";
import type {
	ListCommand,
	ArchiveCommand,
	ForkCommand,
	ResumeCommand,
	SendCommand,
	SendMode,
	StartCommand,
	StopCommand,
	WaitCommand,
} from "./schema.ts";
import {
	resolveListPathReference,
	resolveThreadTarget,
	unknownThreadReferenceError,
} from "./thread-references.ts";

export {
	assertAllowedExtraArgs,
	buildPiArgs,
	collectInheritedPiArgs,
	isCwdInsideOrEqual,
	shouldApproveChildCwd,
} from "./arg-policy.ts";
export {
	PI_THREAD_REGISTRY_ENTRY_TYPE,
	type ThreadRegistryEntryScope,
	type ThreadRegistryPersistence,
	type ThreadRegistryPersistenceTarget,
	type ThreadRegistrySession,
} from "./thread-registry.ts";

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_THREADS = 8;
const RECENT_EVENT_LIMIT = 40;
const STDERR_TAIL_LIMIT = 12_000;
const PROMPT_ACCEPT_TIMEOUT_MS = 4_000;
const RPC_QUICK_TIMEOUT_MS = 1_500;
const RPC_SEND_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 1_500;
const STOP_KILL_WAIT_MS = 300;
const DEFAULT_IDLE_CLEANUP_MS = 0;
const DEFAULT_LIVE_TIMEOUT_MS = 0;
const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;
const WAIT_POLL_INTERVAL_MS = 250;
const BUSY_SEND_IDLE_SETTLE_REFRESHES = 2;
const MESSAGE_UPDATE_EMIT_THROTTLE_MS = 250;
const PERSIST_FLUSH_DELAY_MS = 500;
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

type LiveThread = ThreadBase & {
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
	readonly processLaunchToken?: symbol;
};

type ManagedThread = LiveThread | ClosedThread;

export type ThreadChangeListener = (threads: readonly ThreadSnapshot[]) => void;

export type ThreadManagerScope = {
	readonly currentPath: ThreadPath;
	readonly depth: number;
	readonly selfThreadId: ThreadId | null;
};

type ThreadOutcomeBase<K extends string> = {
	readonly kind: K;
	readonly thread: ThreadSnapshot;
	readonly snapshot: ThreadRuntimeSnapshot;
};

export type StartOutcome = ThreadOutcomeBase<"started"> & {
	readonly promptAccepted: boolean;
	readonly note: string | null;
};

export type SendOutcome = ThreadOutcomeBase<"sent"> & {
	readonly mode: SendMode;
	readonly accepted: boolean;
	readonly error: string | null;
};

export type StopOutcome = ThreadOutcomeBase<"stopped">;

export type ResumeOutcome = ThreadOutcomeBase<"resumed"> & {
	readonly alreadyLive: boolean;
};

export type ForkOutcome = ThreadOutcomeBase<"forked"> & {
	readonly sourceSessionFile: string;
	readonly sourceEntryId: string | null;
};

export type ArchiveOutcome = ThreadOutcomeBase<"archived"> & {
	readonly archived: boolean;
};

export type WaitOutcome = ThreadOutcomeBase<"waited"> & {
	readonly timedOut: boolean;
	readonly waitedMs: number;
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

type ThreadRegistryOwnership = {
	readonly registrySession: ThreadRegistrySession | null;
	readonly registryGeneration: number;
};

type LaunchThreadInput = {
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

type ForkSource = {
	readonly sessionFile: string;
	readonly sessionDir: string | undefined;
	readonly cwd: string;
	readonly displayName: string;
};

type ForkedManagedSession = {
	readonly cwd: string;
	readonly session: KnownThreadSession;
	readonly sourceEntryId: string | null;
};

export class ThreadManager {
	readonly #threads = new Map<ThreadId, ManagedThread>();
	readonly #listeners = new Set<ThreadChangeListener>();
	#messageUpdateChangeTimer: ReturnType<typeof setTimeout> | null = null;
	readonly #baseScope: ThreadManagerScope;
	#depth: number;
	readonly #maxDepth: number;
	readonly #maxThreads: number;
	readonly #idleCleanupMs: number;
	readonly #liveTimeoutMs: number;
	#selfThreadId: ThreadId | null;
	#currentPath: ThreadPath;
	readonly #rootSessionId: string;
	#registrySession: ThreadRegistrySession | null = null;
	#registryGeneration = 0;
	#persistence: ThreadRegistryPersistence = {};
	readonly #dirtyPersistThreadIds = new Set<ThreadId>();
	#persistFlushTimer: ReturnType<typeof setTimeout> | null = null;
	#cleanupTimer: ReturnType<typeof setTimeout> | null = null;
	#cleanupInFlight: Promise<void> | null = null;

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
		this.#idleCleanupMs = readInteger(
			environment["PI_THREADS_IDLE_CLEANUP_MS"],
			DEFAULT_IDLE_CLEANUP_MS,
		);
		this.#liveTimeoutMs = readInteger(
			environment["PI_THREADS_LIVE_TIMEOUT_MS"],
			DEFAULT_LIVE_TIMEOUT_MS,
		);
		this.#selfThreadId = baseSelfThreadId;
		this.#currentPath = baseCurrentPath;
		this.#rootSessionId = environment["PI_THREADS_ROOT_SESSION_ID"] ?? `root_${process.pid}`;
	}

	setPersistence(persistence: ThreadRegistryPersistence): void {
		this.#persistence = persistence;
	}

	#setRegistrySession(session: ThreadRegistrySession | null): void {
		if (!threadRegistrySessionsMatch(this.#registrySession, session)) this.#registryGeneration++;
		this.#registrySession = session;
	}

	#getRegistryOwnership(): ThreadRegistryOwnership {
		return {
			registrySession: this.#registrySession,
			registryGeneration: this.#registryGeneration,
		};
	}

	hydrateFromSession(ctx: Pick<ExtensionContext, "sessionManager">): void {
		this.#setRegistrySession(threadRegistrySessionFromContext(ctx));
		const restoreScope: ThreadRegistryRestoreScope = {
			sessionId: this.#registrySession?.sessionId ?? null,
			sessionStartedAt: safeSessionTimestamp(ctx),
			currentPath: this.#currentPath,
			isRootSessionFork: sessionHasParentSession(ctx) && this.#currentPath === ROOT_THREAD_PATH,
			registrySession: this.#registrySession,
			registryGeneration: this.#registryGeneration,
		};
		const entries = safeSessionBranch(ctx);
		if (entries.length === 0) return;

		let changed = false;
		for (const restored of restoreDurableThreads(entries, restoreScope)) {
			const existing = this.#threads.get(restored.id);
			if (existing !== undefined) {
				if (existing.state === "live") continue;
				const restoredWithPreservedText = preserveRegistryTruncatedText(existing, restored);
				if (threadSnapshotsMatch(existing, restoredWithPreservedText)) {
					if (!threadRegistryMetadataMatches(existing, restored)) {
						this.#threads.set(restored.id, withThreadRegistryMetadata(existing, restored));
					}
					continue;
				}
				this.#threads.set(restored.id, restoredWithPreservedText);
				changed = true;
				continue;
			}
			this.#threads.set(restored.id, restored);
			changed = true;
		}

		if (changed) this.#emitChange();
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

		const visibility = command?.visibility ?? "active";
		if (visibility !== "all") {
			threads = threads.filter((thread) => thread.archived === (visibility === "archived"));
		}

		const parent = command && "parent" in command ? command.parent : undefined;
		if (parent !== undefined) {
			const parentPath = resolveListPathReference(parent, {
				currentPath: this.#currentPath,
				selfThreadId: this.#selfThreadId,
				threads: this.#threads.values(),
			});
			threads = threads.filter((thread) => thread.parentPath === parentPath);
		}

		const ancestor = command && "ancestor" in command ? command.ancestor : undefined;
		if (ancestor !== undefined) {
			const ancestorPath = resolveListPathReference(ancestor, {
				currentPath: this.#currentPath,
				selfThreadId: this.#selfThreadId,
				threads: this.#threads.values(),
			});
			threads = threads.filter(
				(thread) => thread.path !== ancestorPath && thread.path.startsWith(`${ancestorPath}/`),
			);
		}

		threads.sort((left, right) => left.path.localeCompare(right.path));
		return threads.map((thread) => snapshot(thread));
	}

	async start(command: StartCommand, ctx: ExtensionContext): Promise<StartOutcome> {
		const scope = this.getScope();
		const registryOwnership = this.#getRegistryOwnership();
		await this.#cleanupExpiredLiveThreads();
		this.#assertStartAllowed(scope);

		const id = newThreadId();
		const taskName = command.taskName ?? this.#generateUniqueTaskName(command, id, scope);
		assertTaskName(taskName);
		const threadPath = joinThreadPath(scope.currentPath, taskName);
		this.#assertPathAvailable(threadPath);

		const name = command.name ?? generateDisplayName(command.prompt, taskName, id);
		const cwd = resolveCwd(ctx.cwd, command.cwd);
		const extraArgs = command.args ?? [];
		assertAllowedExtraArgs(extraArgs);
		const preparedSession = prepareManagedChildSession(ctx, cwd);
		const launch = await this.#launchThread(
			{
				id,
				name,
				taskName,
				path: threadPath,
				parentPath: scope.currentPath,
				parentThreadId: scope.selfThreadId,
				depth: scope.depth + 1,
				...registryOwnership,
				cwd,
				args: extraArgs,
				session: preparedSession?.session,
				sessionFile:
					preparedSession?.session.kind === "known" ? preparedSession.session.file : undefined,
				startEvent: "thread_started",
				prompt: command.prompt,
			},
			ctx,
		);

		const resultThread = snapshotPair(this.#required(id));
		return {
			kind: "started",
			promptAccepted: launch.promptAccepted,
			note: launch.note,
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
		const id = thread.id;
		thread.inFlightSendCount++;
		let sendTracked = true;

		try {
			const refreshed = await this.#refreshState(thread, { emitChange: false });
			thread = this.#liveByTarget(id);
			const mode = command.mode ?? defaultSendMode(thread.phase);
			const sendAcceptanceBaseline = captureSendAcceptanceBaseline(thread, {
				allowActivityFastPath: refreshed,
			});
			const response = await sendMessage(thread, mode, command.message);
			if (response.success) {
				const current = this.#threads.get(id);
				if (current?.state === "live") {
					recordAcceptedSend(current, sendAcceptanceBaseline);
					this.#persistThreadSnapshot(current);
				}
			}
			this.#finishInFlightSend(id);
			sendTracked = false;
			this.#emitChange();

			return {
				kind: "sent",
				mode,
				accepted: response.success,
				error: response.success ? null : (response.error ?? "Message was rejected by child Pi."),
				...snapshotPair(this.#required(id)),
			};
		} finally {
			if (sendTracked) this.#finishInFlightSend(id);
		}
	}

	async stop(command: StopCommand): Promise<StopOutcome> {
		let thread = this.#requiredByTarget(command.id);
		const id = thread.id;

		if (thread.state === "closed") return { kind: "stopped", ...snapshotPair(thread) };
		if (thread.session.kind !== "known") await this.#refreshSession(thread);

		thread = this.#required(id);
		if (thread.state === "closed") return { kind: "stopped", ...snapshotPair(thread) };

		await this.#stopLiveThread(thread, { force: command.force === true });
		return { kind: "stopped", ...snapshotPair(this.#required(id)) };
	}

	async resume(command: ResumeCommand, ctx: ExtensionContext): Promise<ResumeOutcome> {
		const scope = this.getScope();
		let thread = this.#requiredByTarget(command.id, scope);
		const id = thread.id;
		const registryOwnership: ThreadRegistryOwnership = {
			registrySession: thread.registrySession,
			registryGeneration: thread.registryGeneration,
		};
		if (thread.state === "live") {
			return { kind: "resumed", alreadyLive: true, ...snapshotPair(thread) };
		}
		await this.#cleanupExpiredLiveThreads();

		thread = this.#required(id);
		if (thread.state === "live") {
			return { kind: "resumed", alreadyLive: true, ...snapshotPair(thread) };
		}

		this.#assertStartAllowed(scope);
		if (thread.session.kind !== "known") {
			throw new Error(
				`Cannot resume ${thread.path}: no saved Pi session file is known. Repair: resume only managed threads with a known session file, or start a new thread.`,
			);
		}
		assertSessionFileExists(thread.session.file, "resume");

		await this.#launchThread(
			{
				id: thread.id,
				name: thread.name,
				taskName: thread.taskName,
				path: thread.path,
				parentPath: thread.parentPath,
				parentThreadId: thread.parentThreadId,
				depth: thread.depth,
				...registryOwnership,
				cwd: thread.cwd,
				args: thread.args,
				createdAt: thread.createdAt,
				archived: false,
				session: thread.session,
				sessionFile: thread.session.file,
				lastAssistantText: thread.lastAssistantText,
				recentEvents: thread.recentEvents,
				stderrTail: thread.stderrTail,
				startEvent: "thread_resumed",
			},
			ctx,
		);

		return { kind: "resumed", alreadyLive: false, ...snapshotPair(this.#required(id)) };
	}

	async fork(command: ForkCommand, ctx: ExtensionContext): Promise<ForkOutcome> {
		const scope = this.getScope();
		const registryOwnership = this.#getRegistryOwnership();
		await this.#cleanupExpiredLiveThreads();
		this.#assertStartAllowed(scope);

		const id = newThreadId();
		const extraArgs = command.args ?? [];
		assertAllowedExtraArgs(extraArgs);
		let taskName: string | null = null;
		let threadPath: ThreadPath | null = null;
		if (command.taskName !== undefined) {
			taskName = assertTaskName(command.taskName);
			threadPath = joinThreadPath(scope.currentPath, taskName);
			this.#assertPathAvailable(threadPath);
		} else if (command.name !== undefined) {
			taskName = this.#uniqueTaskName(
				taskNameFromText(command.name) ?? shortTaskName(id),
				id,
				scope,
			);
			threadPath = joinThreadPath(scope.currentPath, taskName);
			this.#assertPathAvailable(threadPath);
		}

		const source = this.#resolveForkSource(command, ctx, scope);
		const baseName = command.name ?? `Fork of ${source.displayName}`;
		if (taskName === null || threadPath === null) {
			taskName = this.#uniqueTaskName(taskNameFromText(baseName) ?? shortTaskName(id), id, scope);
			threadPath = joinThreadPath(scope.currentPath, taskName);
			this.#assertPathAvailable(threadPath);
		}
		const forked = createForkedManagedSession(source, command);

		await this.#launchThread(
			{
				id,
				name: baseName,
				taskName,
				path: threadPath,
				parentPath: scope.currentPath,
				parentThreadId: scope.selfThreadId,
				depth: scope.depth + 1,
				...registryOwnership,
				cwd: forked.cwd,
				args: extraArgs,
				session: forked.session,
				sessionFile: forked.session.file,
				startEvent: "thread_forked",
				sourceSessionFile: source.sessionFile,
				sourceEntryId: forked.sourceEntryId,
			},
			ctx,
		);

		return {
			kind: "forked",
			sourceSessionFile: source.sessionFile,
			sourceEntryId: forked.sourceEntryId,
			...snapshotPair(this.#required(id)),
		};
	}

	archive(command: ArchiveCommand): ArchiveOutcome {
		const thread = this.#requiredByTarget(command.id);
		if (thread.state === "live") {
			throw new Error(
				`Cannot archive live thread ${thread.path}. Repair: stop or wait for the thread to close before archiving, or omit archive for live work.`,
			);
		}

		thread.archived = command.archived ?? true;
		appendThreadEvent(thread, { type: "thread_archived", archived: thread.archived });
		this.#persistThreadSnapshot(thread);
		this.#emitChange();
		return { kind: "archived", archived: thread.archived, ...snapshotPair(thread) };
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
		this.#clearScheduledCleanup();
		const liveThreads = Array.from(this.#threads.values()).filter(
			(thread): thread is LiveThread => thread.state === "live",
		);
		await Promise.all(liveThreads.map((thread) => this.#stopLiveThread(thread, { force: false })));
		this.#flushScheduledPersists();
		this.#emitChange();
	}

	/**
	 * Forget all closed threads. Used after a full shutdown when the parent moves
	 * to an unrelated session: the process-wide manager instance stays referenced
	 * by registered tool/command closures, and without this purge the next session
	 * would still list the previous session's threads. Live threads are kept
	 * defensively; a full shutdown closes them first.
	 */
	clearThreads(): void {
		this.#clearScheduledPersistFlush();
		let changed = false;
		for (const [id, thread] of this.#threads) {
			if (thread.state !== "closed") continue;
			this.#threads.delete(id);
			changed = true;
		}
		if (changed) this.#emitChange();
	}

	async #stopLiveThread(
		thread: LiveThread,
		options: { readonly force: boolean },
	): Promise<ManagedThread> {
		const id = thread.id;
		const current = this.#threads.get(id);
		if (current !== thread) return current ?? thread;

		current.stopRequested = true;
		if (current.phase !== "stopping") {
			setThreadPhase(current, "stopping");
			appendThreadEvent(current, { type: "thread_stopping" });
			this.#persistThreadSnapshot(current);
			this.#emitChange();
		}

		if (options.force) {
			await signalThreadProcessTree(current, "SIGKILL");
			await Promise.race([current.closed, delay(STOP_KILL_WAIT_MS)]);
		} else {
			await current.rpc.request({ type: "abort" }, RPC_QUICK_TIMEOUT_MS).catch(() => undefined);
			if (this.#threads.get(id) === current) await signalThreadProcessTree(current, "SIGTERM");
			await Promise.race([current.closed, delay(STOP_GRACE_MS)]);
			if (this.#threads.get(id) === current) {
				await signalThreadProcessTree(current, "SIGKILL");
				await Promise.race([current.closed, delay(STOP_KILL_WAIT_MS)]);
			}
		}

		if (this.#threads.get(id) === current) {
			this.#closeThread(id, { kind: "stopped", code: null, signal: "SIGKILL" });
		}

		this.#emitChange();
		return this.#required(id);
	}

	async #launchThread(
		input: LaunchThreadInput,
		ctx: ExtensionContext,
	): Promise<{ readonly promptAccepted: boolean; readonly note: string | null }> {
		const inheritedArgs = collectInheritedPiArgs(process.argv, PROCESS_START_CWD);
		const argv = buildPiArgs({
			name: input.name,
			extraArgs: input.args,
			inheritedArgs,
			projectTrusted: shouldApproveChildCwd(ctx.isProjectTrusted(), ctx.cwd, input.cwd),
			sessionFile: input.sessionFile,
		});
		const invocation = getPiInvocation(argv);
		const childEnvironment = {
			...process.env,
			PI_THREADS_DEPTH: String(input.depth),
			PI_THREADS_MAX_DEPTH: String(this.#maxDepth),
			PI_THREADS_MAX_THREADS: String(this.#maxThreads),
			PI_THREADS_IDLE_CLEANUP_MS: String(this.#idleCleanupMs),
			PI_THREADS_LIVE_TIMEOUT_MS: String(this.#liveTimeoutMs),
			PI_THREADS_SELF_ID: input.id,
			PI_THREADS_PARENT_ID: input.parentThreadId ?? "",
			PI_THREADS_PARENT_THREAD_ID: input.parentThreadId ?? "",
			PI_THREADS_PARENT_PATH: input.parentPath,
			PI_THREADS_PATH: input.path,
			PI_THREADS_ROOT_SESSION_ID: this.#rootSessionId,
		};

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(invocation.command, invocation.args, {
				cwd: input.cwd,
				env: childEnvironment,
				detached: shouldLaunchDetachedProcessGroup(),
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
		let launchedThread: LiveThread | null = null;
		child.once("error", (error) => {
			if (launchedThread === null) {
				pendingStart.spawnError = error;
				return;
			}
			if (this.#threads.get(input.id) !== launchedThread) return;
			this.#closeThread(input.id, { kind: "failed", message: error.message });
		});

		child.once("close", (code, signal) => {
			if (launchedThread === null) {
				pendingStart.close = { code, signal };
				return;
			}
			const current = this.#threads.get(input.id);
			if (current !== launchedThread) {
				this.#recordLateProcessExit(launchedThread, code, signal);
				return;
			}
			const stopped = current.stopRequested;
			this.#closeThread(input.id, classifyProcessExit({ code, signal, stopped }));
		});

		if (child.pid === undefined) {
			child.kill("SIGKILL");
			const reason =
				pendingStart.spawnError === null ? "missing pid" : pendingStart.spawnError.message;
			throw new Error(`Unable to start child Pi process: ${reason}`);
		}

		const previousThread = this.#threads.get(input.id);
		const registrySession = previousThread?.registrySession ?? input.registrySession;
		const registryGeneration = previousThread?.registryGeneration ?? input.registryGeneration;
		const closedDeferred = createDeferred<void>();
		const recentEvents = [...(input.recentEvents ?? [])];
		const liveStartedAt = nowIso();
		const thread: LiveThread = {
			state: "live",
			processLaunchToken: Symbol(input.id),
			id: input.id,
			name: input.name,
			taskName: input.taskName,
			path: input.path,
			parentPath: input.parentPath,
			parentThreadId: input.parentThreadId,
			depth: input.depth,
			registrySession,
			registryGeneration,
			archived: input.archived ?? false,
			cwd: input.cwd,
			args: [...input.args],
			createdAt: input.createdAt ?? liveStartedAt,
			lastEventAt: liveStartedAt,
			session: input.session ?? { kind: "unknown" },
			lastAssistantText: input.lastAssistantText ?? null,
			lastPartialText: null,
			recentEvents,
			nextEventSeq: Math.max(0, ...recentEvents.map((event) => event.seq)) + 1,
			stderrTail: input.stderrTail ?? "",
			liveStartedAt,
			idleStartedAt: null,
			phase: "starting",
			pid: child.pid,
			processGroupId: process.platform === "win32" ? null : child.pid,
			child,
			rpc: new RpcClient(child, (event) => {
				if (launchedThread === null || this.#threads.get(input.id) !== launchedThread) return;
				this.#handleRpcEvent(input.id, event);
			}),
			stopRequested: false,
			hasRun: false,
			activityGeneration: 0,
			userMessageStartGeneration: 0,
			inFlightSendCount: 0,
			awaitingSend: null,
			pendingInitialPrompt: null,
			turnOpen: false,
			closed: closedDeferred.promise,
			resolveClosed: closedDeferred.resolve,
		};

		launchedThread = thread;
		this.#threads.set(input.id, thread);
		appendLaunchThreadEvent(thread, input, child.pid);
		this.#persistThreadSnapshot(thread);
		this.#emitChange();

		child.stderr.on("data", (chunk: Buffer | string) => {
			const current = this.#threads.get(input.id);
			if (current !== thread) return;
			current.stderrTail = tail(`${current.stderrTail}${String(chunk)}`, STDERR_TAIL_LIMIT);
			current.lastEventAt = nowIso();
		});

		if (pendingStart.spawnError !== null) {
			this.#closeThread(input.id, { kind: "failed", message: pendingStart.spawnError.message });
		} else if (pendingStart.close !== null) {
			this.#closeThread(
				input.id,
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
		if (input.prompt !== undefined) {
			try {
				const request = thread.rpc.requestWithHandle(
					{ type: "prompt", message: input.prompt },
					PROMPT_ACCEPT_TIMEOUT_MS,
				);
				thread.pendingInitialPrompt = { requestId: request.id };

				const response = await request.response;
				promptAccepted = response.success;
				this.#recordInitialPromptResponse(input.id, response);
				if (!response.success) {
					note = response.error ?? "Prompt was rejected by child Pi.";
				}
			} catch (error) {
				note = error instanceof Error ? error.message : String(error);
			}
		} else if (this.#threads.get(input.id)?.state === "live") {
			const current = this.#threads.get(input.id);
			if (current?.state === "live" && current.phase === "starting")
				setThreadPhase(current, "idle");
		}

		const current = this.#threads.get(input.id);
		if (current?.state === "live" && current.session.kind !== "known") {
			await this.#refreshSession(current);
		}
		this.#persistThreadSnapshot(this.#required(input.id));
		this.#emitChange();

		return { promptAccepted, note };
	}

	#persistThreadSnapshot(thread: ManagedThread): void {
		this.#dirtyPersistThreadIds.delete(thread.id);
		try {
			const target = this.#registryTarget(thread);
			if (target === null) return;
			this.#persistence.appendSnapshot?.(
				truncateSnapshotForRegistry(snapshot(thread)),
				registryScope(target),
				target,
			);
		} catch {
			// Persistence should never affect process lifecycle management.
		}
	}

	#persistThreadSnapshotAndEmitChange(thread: ManagedThread): void {
		this.#persistThreadSnapshot(thread);
		this.#emitChange();
	}

	// High-frequency lifecycle events (tool starts/ends) coalesce into one trailing
	// registry append instead of one per event; any direct persist supersedes them.
	#schedulePersistThreadSnapshot(thread: ManagedThread): void {
		this.#dirtyPersistThreadIds.add(thread.id);
		if (this.#persistFlushTimer !== null) return;
		this.#persistFlushTimer = setTimeout(() => {
			this.#persistFlushTimer = null;
			this.#flushScheduledPersists();
		}, PERSIST_FLUSH_DELAY_MS);
		this.#persistFlushTimer.unref?.();
	}

	#flushScheduledPersists(): void {
		const ids = [...this.#dirtyPersistThreadIds];
		this.#dirtyPersistThreadIds.clear();
		for (const id of ids) {
			const thread = this.#threads.get(id);
			if (thread !== undefined) this.#persistThreadSnapshot(thread);
		}
	}

	#clearScheduledPersistFlush(): void {
		if (this.#persistFlushTimer !== null) {
			clearTimeout(this.#persistFlushTimer);
			this.#persistFlushTimer = null;
		}
		this.#dirtyPersistThreadIds.clear();
	}

	#registryTarget(thread: ManagedThread): ThreadRegistryPersistenceTarget | null {
		if (thread.registrySession !== null) {
			return {
				...thread.registrySession,
				isCurrentSession: threadRegistrySessionsMatch(
					thread.registrySession,
					this.#registrySession,
				),
			};
		}

		if (thread.registryGeneration !== this.#registryGeneration) return null;
		if (this.#registrySession !== null) return { ...this.#registrySession, isCurrentSession: true };
		return { sessionId: null, sessionFile: null, sessionDir: null, isCurrentSession: true };
	}

	#assertStartAllowed(scope: ThreadManagerScope): void {
		if (scope.depth >= this.#maxDepth) {
			throw new Error(
				`pi-threads recursion depth ${scope.depth} has reached PI_THREADS_MAX_DEPTH=${this.#maxDepth}`,
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
		if (!thread) throw unknownThreadReferenceError(id, this.#threads.values());
		return thread;
	}

	#requiredByTarget(target: string, scope: ThreadManagerScope = this.getScope()): ManagedThread {
		return this.#required(
			resolveThreadTarget(target, {
				currentPath: scope.currentPath,
				threads: this.#threads.values(),
			}),
		);
	}

	#liveByTarget(target: string): LiveThread {
		const thread = this.#requiredByTarget(target);
		if (thread.state === "closed") throw new Error(`Thread is closed: ${target}`);
		return thread;
	}

	#resolveForkSource(
		command: ForkCommand,
		ctx: ExtensionContext,
		scope: ThreadManagerScope,
	): ForkSource {
		if (command.id !== undefined) {
			const sourceThread = this.#requiredByTarget(command.id, scope);
			if (sourceThread.session.kind !== "known") {
				throw new Error(
					`Cannot fork ${sourceThread.path}: no saved Pi session file is known. Repair: fork only managed threads with known session files, or omit fork.id to fork the current parent session.`,
				);
			}
			assertSessionFileExists(sourceThread.session.file, "fork");
			return {
				sessionFile: sourceThread.session.file,
				sessionDir: undefined,
				cwd: sourceThread.cwd,
				displayName: sourceThread.name,
			};
		}

		const sessionFile = safeGetSessionFile(ctx);
		if (sessionFile === undefined) {
			throw new Error(
				"Cannot fork the current parent session because it has no saved Pi session file. Repair: start Pi with sessions enabled, fork a managed child by id, or start a new thread instead.",
			);
		}
		materializeSessionManagerFile(ctx.sessionManager);
		assertSessionFileExists(sessionFile, "fork");
		return {
			sessionFile,
			sessionDir: safeGetSessionDir(ctx),
			cwd: ctx.cwd,
			displayName: "current session",
		};
	}

	#generateUniqueTaskName(command: StartCommand, id: ThreadId, scope: ThreadManagerScope): string {
		const base =
			taskNameFromText(command.name) ?? taskNameFromText(command.prompt) ?? shortTaskName(id);
		return this.#uniqueTaskName(base, id, scope);
	}

	#uniqueTaskName(base: string, id: ThreadId, scope: ThreadManagerScope): string {
		for (let attempt = 1; attempt <= 10_000; attempt += 1) {
			const candidate = taskNameWithNumericSuffix(base, attempt);
			if (this.#findByPath(joinThreadPath(scope.currentPath, candidate)) === undefined) {
				return candidate;
			}
		}

		const idBase = assertTaskName(id);
		for (let attempt = 1; attempt <= 100; attempt += 1) {
			const candidate = taskNameWithNumericSuffix(idBase, attempt);
			if (this.#findByPath(joinThreadPath(scope.currentPath, candidate)) === undefined) {
				return candidate;
			}
		}

		throw new Error(
			`Unable to generate a unique taskName under ${scope.currentPath}. Repair: provide an explicit unique start.taskName.`,
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

	// A forced stop synthesizes a close after SIGKILL if the process "close" event
	// has not been observed yet. When the real exit arrives later, replace the
	// synthetic exit so the snapshot reflects what actually happened.
	#recordLateProcessExit(
		launchedThread: LiveThread,
		code: number | null,
		signal: string | null,
	): void {
		const id = launchedThread.id;
		const current = this.#threads.get(id);
		if (
			current === undefined ||
			current.state !== "closed" ||
			current.processLaunchToken !== launchedThread.processLaunchToken ||
			current.exit.kind !== "stopped" ||
			current.exit.code !== null ||
			current.exit.signal !== "SIGKILL"
		) {
			return;
		}

		const observed = classifyProcessExit({ code, signal, stopped: true });
		if (
			observed.kind === "stopped" &&
			observed.code === current.exit.code &&
			observed.signal === current.exit.signal
		) {
			return;
		}

		const updated: ClosedThread = { ...current, exit: observed, lastEventAt: nowIso() };
		this.#threads.set(id, updated);
		this.#persistThreadSnapshot(updated);
		this.#emitChange();
	}

	#closeThread(id: ThreadId, exit: ThreadExit): void {
		const thread = this.#threads.get(id);
		if (!thread || thread.state === "closed") return;

		const closed: ClosedThread = {
			state: "closed",
			processLaunchToken: thread.processLaunchToken,
			id: thread.id,
			name: thread.name,
			taskName: thread.taskName,
			path: thread.path,
			parentPath: thread.parentPath,
			parentThreadId: thread.parentThreadId,
			depth: thread.depth,
			registrySession: thread.registrySession,
			registryGeneration: thread.registryGeneration,
			archived: thread.archived,
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
		this.#persistThreadSnapshot(closed);
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
			setThreadPhase(thread, "idle");
		}
		return true;
	}

	#handleRpcEvent(id: ThreadId, clientEvent: RpcClientEvent): void {
		const thread = this.#threads.get(id);
		if (!thread || thread.state === "closed") return;

		thread.lastEventAt = nowIso();

		if (clientEvent.kind === "parse_error") {
			appendThreadEvent(thread, { type: "thread_error", message: clientEvent.message });
			this.#persistThreadSnapshotAndEmitChange(thread);
			return;
		}

		if (clientEvent.kind === "response") {
			if (this.#recordInitialPromptResponse(id, clientEvent.response)) {
				this.#persistThreadSnapshotAndEmitChange(thread);
			}
			return;
		}

		const event = clientEvent.event;
		const type = stringField(event, "type");
		switch (type) {
			case "agent_start": {
				recordPromptRunActivity(thread);
				setThreadPhase(thread, "busy");
				thread.hasRun = true;
				recordThreadTurnStarted(thread);
				this.#persistThreadSnapshotAndEmitChange(thread);
				return;
			}
			case "agent_end": {
				recordPromptRunActivity(thread);
				setThreadPhase(thread, "idle");
				thread.lastPartialText = null;
				allowAwaitingSendRunActivity(thread);
				clearObservedSendIfIdle(thread);
				recordThreadTurnCompleted(thread);
				this.#persistThreadSnapshotAndEmitChange(thread);
				return;
			}
			case "turn_start": {
				recordPromptRunActivity(thread);
				setThreadPhase(thread, "busy");
				thread.hasRun = true;
				recordThreadTurnStarted(thread);
				this.#persistThreadSnapshotAndEmitChange(thread);
				return;
			}
			case "message_start": {
				recordPromptRunActivity(thread);
				if (isUserMessage(event["message"])) thread.userMessageStartGeneration++;
				setThreadPhase(thread, "busy");
				thread.hasRun = true;
				recordThreadTurnStarted(thread);
				this.#persistThreadSnapshotAndEmitChange(thread);
				return;
			}
			case "turn_end": {
				recordPromptRunActivity(thread);
				allowAwaitingSendRunActivity(thread);
				recordThreadTurnCompleted(thread);
				this.#persistThreadSnapshotAndEmitChange(thread);
				return;
			}
			case "message_update": {
				recordPromptRunActivity(thread);
				const text = extractAssistantText(event["message"]);
				if (text !== null && text !== thread.lastPartialText) {
					thread.lastPartialText = text;
					this.#scheduleMessageUpdateChange();
				}
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
					this.#persistThreadSnapshotAndEmitChange(thread);
				}
				return;
			}
			case "tool_execution_start": {
				recordPromptRunActivity(thread);
				setThreadPhase(thread, "busy");
				recordThreadTurnStarted(thread);
				appendThreadEvent(thread, {
					type: "tool_started",
					toolName: stringField(event, "toolName") ?? "unknown",
				});
				this.#schedulePersistThreadSnapshot(thread);
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
				this.#schedulePersistThreadSnapshot(thread);
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
				this.#persistThreadSnapshotAndEmitChange(thread);
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
		if (this.#threads.get(thread.id) !== thread) return;
		if (captureSession(thread, data)) {
			this.#persistThreadSnapshot(thread);
			this.#emitChange();
		}
	}

	async #refreshState(
		thread: LiveThread,
		options: { readonly emitChange?: boolean; readonly timeoutMs?: number } = { emitChange: true },
	): Promise<boolean> {
		const requestOptions =
			options.timeoutMs === undefined
				? { recordErrors: true }
				: { recordErrors: true, timeoutMs: options.timeoutMs };
		const before = liveThreadDurabilitySignature(thread);
		const data = await this.#requestState(thread, requestOptions);
		if (this.#threads.get(thread.id) !== thread) return false;
		if (data === null) {
			if (liveThreadDurabilitySignature(thread) !== before) this.#persistThreadSnapshot(thread);
			return false;
		}

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
				setThreadPhase(thread, "busy");
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
					setThreadPhase(thread, "idle");
					clearObservedSendIfIdle(thread);
				} else if (thread.awaitingSend.requireObservedActivity) {
					setThreadPhase(thread, "busy");
				} else {
					thread.awaitingSend.idleRefreshCount++;
					if (thread.awaitingSend.idleRefreshCount >= thread.awaitingSend.idleRefreshesToSettle) {
						thread.awaitingSend = null;
						setThreadPhase(thread, "idle");
					} else {
						setThreadPhase(thread, "busy");
					}
				}
			} else if (
				thread.phase !== "starting" ||
				thread.hasRun ||
				thread.lastAssistantText !== null
			) {
				setThreadPhase(thread, "idle");
			}
		}
		if (childAppearsIdle && thread.phase !== "stopping") recordThreadTurnCompleted(thread);
		if (liveThreadDurabilitySignature(thread) !== before) this.#persistThreadSnapshot(thread);
		if (options.emitChange ?? true) this.#emitChange();
		return true;
	}

	#scheduleMessageUpdateChange(): void {
		if (this.#listeners.size === 0 || this.#messageUpdateChangeTimer !== null) return;
		this.#messageUpdateChangeTimer = setTimeout(() => {
			this.#messageUpdateChangeTimer = null;
			this.#emitChange();
		}, MESSAGE_UPDATE_EMIT_THROTTLE_MS);
		this.#messageUpdateChangeTimer.unref();
	}

	#finishInFlightSend(id: ThreadId): void {
		const current = this.#threads.get(id);
		if (current?.state === "live" && current.inFlightSendCount > 0) {
			current.inFlightSendCount--;
		}
		this.#scheduleCleanup();
	}

	#clearScheduledMessageUpdateChange(): void {
		if (this.#messageUpdateChangeTimer === null) return;
		clearTimeout(this.#messageUpdateChangeTimer);
		this.#messageUpdateChangeTimer = null;
	}

	#scheduleCleanup(): void {
		this.#clearScheduledCleanup();
		if (this.#idleCleanupMs <= 0 && this.#liveTimeoutMs <= 0) return;

		const nextAt = this.#nextCleanupAt(Date.now());
		if (nextAt === null) return;
		const delayMs = Math.max(0, nextAt - Date.now());

		this.#cleanupTimer = setTimeout(
			() => {
				this.#cleanupTimer = null;
				void this.#cleanupExpiredLiveThreads();
			},
			// Node overflows larger timeout delays to 1ms, so wait in safe chunks.
			Math.min(delayMs, MAX_SET_TIMEOUT_DELAY_MS),
		);
		this.#cleanupTimer.unref?.();
	}

	#clearScheduledCleanup(): void {
		if (this.#cleanupTimer === null) return;
		clearTimeout(this.#cleanupTimer);
		this.#cleanupTimer = null;
	}

	#nextCleanupAt(nowMs: number): number | null {
		let nextAt: number | null = null;
		for (const thread of this.#threads.values()) {
			if (thread.state !== "live") continue;
			const deadline = this.#cleanupDeadline(thread);
			if (deadline === null) continue;
			const boundedDeadline = Math.max(nowMs, deadline);
			if (nextAt === null || boundedDeadline < nextAt) nextAt = boundedDeadline;
		}
		return nextAt;
	}

	#cleanupDeadline(thread: LiveThread): number | null {
		if (thread.stopRequested || thread.phase === "stopping") return null;
		const deadlines: number[] = [];
		if (this.#liveTimeoutMs > 0)
			deadlines.push(isoTimeMs(thread.liveStartedAt) + this.#liveTimeoutMs);
		if (
			this.#idleCleanupMs > 0 &&
			thread.phase === "idle" &&
			thread.inFlightSendCount === 0 &&
			thread.awaitingSend === null &&
			hasNoPendingMessages(thread)
		) {
			// lastEventAt includes parent-side RPC responses (for example poll/get_state),
			// so base idle cleanup on the idle deadline anchor instead.
			const idleSinceMs = isoTimeMs(thread.idleStartedAt ?? thread.lastEventAt);
			deadlines.push(idleSinceMs + this.#idleCleanupMs);
		}
		return deadlines.length === 0 ? null : Math.min(...deadlines);
	}

	async #cleanupExpiredLiveThreads(): Promise<void> {
		for (;;) {
			const inFlight = this.#cleanupInFlight;
			if (inFlight !== null) {
				// eslint-disable-next-line no-await-in-loop -- callers must wait for the active pass, then re-check newly expired threads.
				await inFlight;
				continue;
			}

			if (this.#expiredLiveThreads(Date.now()).length === 0) {
				this.#scheduleCleanup();
				return;
			}

			const cleanup = Promise.resolve().then(() => this.#runCleanupExpiredLiveThreads());
			this.#cleanupInFlight = cleanup;
			try {
				// eslint-disable-next-line no-await-in-loop -- cleanup drains expiration waves before limit checks continue.
				await cleanup;
			} finally {
				if (this.#cleanupInFlight === cleanup) this.#cleanupInFlight = null;
				this.#scheduleCleanup();
			}
		}
	}

	#expiredLiveThreads(nowMs: number): LiveThread[] {
		return Array.from(this.#threads.values()).filter(
			(thread): thread is LiveThread =>
				thread.state === "live" &&
				(this.#cleanupDeadline(thread) ?? Number.POSITIVE_INFINITY) <= nowMs,
		);
	}

	async #runCleanupExpiredLiveThreads(): Promise<void> {
		const expired = this.#expiredLiveThreads(Date.now());
		await Promise.all(expired.map((thread) => this.#stopLiveThread(thread, { force: false })));
	}

	#emitChange(): void {
		this.#clearScheduledMessageUpdateChange();
		this.#scheduleCleanup();
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

function threadRegistrySessionFromContext(
	ctx: Pick<ExtensionContext, "sessionManager">,
): ThreadRegistrySession | null {
	const sessionId = safeGetSessionId(ctx);
	const sessionFile = safeGetSessionFile(ctx) ?? null;
	const sessionDir = safeGetSessionDir(ctx) ?? null;
	if (sessionId === null && sessionFile === null && sessionDir === null) return null;
	return { sessionId, sessionFile, sessionDir };
}

function liveThreadDurabilitySignature(thread: LiveThread): string {
	return JSON.stringify({
		archived: thread.archived,
		lastAssistantText: thread.lastAssistantText,
		lastPartialText: thread.lastPartialText,
		phase: thread.phase,
		recentEvents: thread.recentEvents,
		session: thread.session,
		stderrTail: thread.stderrTail,
	});
}

function prepareManagedChildSession(
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

function createForkedManagedSession(
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

type MaterializableSessionManager = {
	readonly getSessionFile: () => string | undefined;
	readonly getHeader: () => unknown;
	readonly getEntries: () => readonly unknown[];
};

function materializeSessionManagerFile(sessionManager: MaterializableSessionManager): void {
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile === undefined || fs.existsSync(sessionFile)) return;
	if (rewriteSessionManagerFile(sessionManager, sessionFile)) return;

	const header = sessionManager.getHeader();
	if (header === null) throw new Error("Cannot materialize Pi session: missing session header.");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
	fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`, { flag: "wx" });
	markSessionManagerFileFlushed(sessionManager);
}

function rewriteSessionManagerFile(
	sessionManager: MaterializableSessionManager,
	sessionFile: string,
): boolean {
	const internals = sessionManager as MaterializableSessionManager & {
		readonly isPersisted?: () => boolean;
		flushed?: boolean;
	} & Record<string, unknown>;
	if (typeof internals.isPersisted === "function" && !internals.isPersisted.call(sessionManager)) {
		return false;
	}
	const rewriteFile = internals["_rewriteFile"];
	if (typeof rewriteFile !== "function") return false;

	try {
		rewriteFile.call(sessionManager);
	} catch {
		return false;
	}

	if (!fs.existsSync(sessionFile)) return false;
	markSessionManagerFileFlushed(sessionManager);
	return true;
}

function markSessionManagerFileFlushed(sessionManager: MaterializableSessionManager): void {
	(sessionManager as { flushed?: boolean }).flushed = true;
}

function safeGetSessionFile(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile?.();
	} catch {
		return undefined;
	}
}

function safeGetSessionId(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
	try {
		return ctx.sessionManager.getSessionId?.() ?? null;
	} catch {
		return null;
	}
}

function sessionHasParentSession(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
	try {
		const header = ctx.sessionManager.getHeader?.();
		return (
			isRecord(header) &&
			typeof header["parentSession"] === "string" &&
			header["parentSession"].length > 0
		);
	} catch {
		return false;
	}
}

function safeSessionTimestamp(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
	try {
		const header = ctx.sessionManager.getHeader?.();
		return isRecord(header) ? stringField(header, "timestamp") : null;
	} catch {
		return null;
	}
}

function safeGetSessionDir(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	try {
		return ctx.sessionManager.getSessionDir?.();
	} catch {
		return undefined;
	}
}

function assertSessionFileExists(sessionFile: string, action: "resume" | "fork"): void {
	if (fs.existsSync(sessionFile)) return;
	throw new Error(
		`Cannot ${action} managed thread: saved Pi session file does not exist: ${sessionFile}. Repair: choose a thread with an existing session file, or start/fork a new thread.`,
	);
}

function safeSessionBranch(ctx: Pick<ExtensionContext, "sessionManager">): readonly unknown[] {
	try {
		return ctx.sessionManager.getBranch?.() ?? [];
	} catch {
		return [];
	}
}

function restoreDurableThreads(
	entries: readonly unknown[],
	scope: ThreadRegistryRestoreScope,
): readonly ClosedThread[] {
	return restoreDurableThreadData(entries, scope).map((data) =>
		snapshotToRestoredThread(data, scope),
	);
}

function threadSnapshotsMatch(left: ManagedThread, right: ManagedThread): boolean {
	return JSON.stringify(snapshot(left)) === JSON.stringify(snapshot(right));
}

function preserveRegistryTruncatedText(
	existing: ClosedThread,
	restored: ClosedThread,
): ClosedThread {
	if (!registryTruncatedTextMatchesFull(restored.lastAssistantText, existing.lastAssistantText)) {
		return restored;
	}

	return { ...restored, lastAssistantText: existing.lastAssistantText };
}

function withThreadRegistryMetadata(thread: ClosedThread, restored: ClosedThread): ClosedThread {
	return {
		...thread,
		registrySession: restored.registrySession,
		registryGeneration: restored.registryGeneration,
	};
}

function threadRegistryMetadataMatches(left: ManagedThread, right: ManagedThread): boolean {
	return (
		left.registryGeneration === right.registryGeneration &&
		threadRegistrySessionsMatch(left.registrySession, right.registrySession)
	);
}

function snapshotToRestoredThread(
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

type ThreadEventInput = ThreadEvent extends infer Event
	? Event extends ThreadEvent
		? Omit<Event, "seq" | "at">
		: never
	: never;

function appendThreadEvent(thread: ThreadBase, event: ThreadEventInput): void {
	appendThreadEventAt(thread, event, nowIso());
}

function appendThreadEventAt(thread: ThreadBase, event: ThreadEventInput, at: string): void {
	const nextEvent = { ...event, seq: thread.nextEventSeq, at } as ThreadEvent;
	thread.nextEventSeq++;
	thread.lastEventAt = at;
	thread.recentEvents.push(nextEvent);
	if (thread.recentEvents.length > RECENT_EVENT_LIMIT)
		thread.recentEvents.splice(0, thread.recentEvents.length - RECENT_EVENT_LIMIT);
}

function appendLaunchThreadEvent(thread: LiveThread, input: LaunchThreadInput, pid: number): void {
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

function sameSessionFile(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}

function setThreadPhase(thread: LiveThread, phase: ThreadPhase): void {
	if (thread.phase === phase) {
		if (phase === "idle" && thread.idleStartedAt === null) thread.idleStartedAt = nowIso();
		return;
	}

	thread.phase = phase;
	thread.idleStartedAt = phase === "idle" ? nowIso() : null;
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
			setThreadPhase(thread, "busy");
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
	if (thread.phase !== "stopping") setThreadPhase(thread, "busy");
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
	// Child-side activity while the thread remains idle should start a fresh
	// idle-cleanup window without letting parent-side polls extend it.
	if (thread.phase === "idle") thread.idleStartedAt = nowIso();
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

function shouldLaunchDetachedProcessGroup(): boolean {
	return process.platform !== "win32";
}

async function signalThreadProcessTree(thread: LiveThread, signal: NodeJS.Signals): Promise<void> {
	if (process.platform === "win32") {
		if (signal === "SIGKILL") {
			if (await taskkillWindowsProcessTree(thread.pid)) return;
		}

		safeKillChild(thread, signal);
		return;
	}

	if (thread.processGroupId !== null) {
		try {
			process.kill(-thread.processGroupId, signal);
			return;
		} catch {
			// Fall back to the direct child process. Process groups can already be gone
			// or unavailable under tests/sandboxes; stopping must remain best-effort.
		}
	}

	safeKillChild(thread, signal);
}

function taskkillWindowsProcessTree(pid: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(ok);
		};
		const timeout = setTimeout(() => finish(false), STOP_KILL_WAIT_MS);
		timeout.unref?.();

		try {
			const taskkill = execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], (error) => {
				finish(error === null);
			});
			taskkill.on?.("error", () => finish(false));
		} catch {
			finish(false);
		}
	});
}

function safeKillChild(thread: LiveThread, signal: NodeJS.Signals): void {
	try {
		thread.child.kill(signal);
	} catch {
		// Process cleanup is best-effort; lifecycle code synthesizes a final stopped
		// snapshot if no close event arrives after the bounded wait.
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
	// Reject partial parses such as "5x" instead of silently reading them as 5.
	if (!/^\d+$/u.test(value.trim())) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function isoTimeMs(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Date.now();
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
