import * as fs from "node:fs";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	DEFAULT_THREAD_DETAIL,
	assertNever,
	toThreadRuntimeSnapshot,
	type ThreadDetail,
	type ThreadRuntimeSnapshot,
	type ThreadSnapshot,
} from "./domain.ts";
import {
	formatList,
	formatPoll,
	formatArchive,
	formatFork,
	formatResume,
	formatSend,
	formatStart,
	formatStop,
	formatThreadTitle,
	formatWaitProgress,
	formatWait,
} from "./format.ts";
import { assertPiThreadParams, PiThreadParamsSchema } from "./schema.ts";
import { registerThreadsCommand } from "./threads-command.ts";
import {
	PI_THREAD_REGISTRY_ENTRY_TYPE,
	ThreadManager,
	type ThreadRegistryPersistenceTarget,
	type ThreadManagerScope,
	type WaitProgress,
} from "./thread-manager.ts";
import { PI_THREAD_DESCRIPTION } from "./prompt.ts";

const PROCESS_MANAGER_KEY = "__piThreadsProcessManager";

type PiThreadsGlobal = typeof globalThis & {
	[PROCESS_MANAGER_KEY]?: ThreadManager;
};

function getProcessManager(): ThreadManager {
	const store = globalThis as PiThreadsGlobal;
	store[PROCESS_MANAGER_KEY] ??= new ThreadManager();
	return store[PROCESS_MANAGER_KEY];
}

function clearProcessManager(manager: ThreadManager): void {
	const store = globalThis as PiThreadsGlobal;
	if (store[PROCESS_MANAGER_KEY] === manager) delete store[PROCESS_MANAGER_KEY];
}

function formatTimeoutMsForTitle(timeoutMs: number): string {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) return `${timeoutMs}ms`;
	const wholeSeconds = Math.trunc(timeoutMs / 1000);
	const milliseconds = timeoutMs % 1000;
	if (milliseconds === 0) return `${wholeSeconds}s`;
	const fractionalSeconds = String(milliseconds).padStart(3, "0").replace(/0+$/u, "");
	return `${wholeSeconds}.${fractionalSeconds}s`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error("Thread action aborted");
}

// ---- Extension entrypoint ----

type ThreadsSessionShutdownAction =
	| { readonly kind: "shutdown" }
	| { readonly kind: "preserve" }
	| { readonly kind: "stop_target"; readonly thread: ThreadSnapshot };

type ThreadRegistryEntryScope = {
	readonly sessionId: string;
};

type SingleThreadResultDetails = {
	readonly kind: string;
	readonly thread: ThreadRuntimeSnapshot;
	readonly snapshot: ThreadRuntimeSnapshot;
	readonly running: boolean;
	readonly nextSuggestedActions: readonly string[];
	readonly detail: ThreadDetail;
};

function withThreadResultDetails<
	T extends { readonly kind: string; readonly thread: ThreadSnapshot },
>(
	details: T,
	detail: ThreadDetail = DEFAULT_THREAD_DETAIL,
): Omit<T, "thread" | "snapshot"> & SingleThreadResultDetails {
	const snapshot = toThreadRuntimeSnapshot(details.thread, { detail });
	const {
		thread: _thread,
		snapshot: _snapshot,
		...rest
	} = details as T & {
		readonly snapshot?: ThreadRuntimeSnapshot;
	};
	return {
		...rest,
		snapshot,
		thread: snapshot,
		running: snapshot.running,
		nextSuggestedActions: snapshot.nextSuggestedActions,
		detail,
	};
}

function listResultDetails(
	threads: readonly ThreadSnapshot[],
	detail: ThreadDetail = DEFAULT_THREAD_DETAIL,
) {
	const snapshots = threads.map((thread) => toThreadRuntimeSnapshot(thread, { detail }));
	return {
		kind: "listed" as const,
		threads: snapshots,
		snapshots,
		count: snapshots.length,
		liveCount: snapshots.filter((snapshot) => snapshot.status === "live").length,
		closedCount: snapshots.filter((snapshot) => snapshot.status === "closed").length,
		detail,
	};
}

function scopeForThread(thread: ThreadSnapshot): ThreadManagerScope {
	return {
		currentPath: thread.path,
		depth: thread.depth,
		selfThreadId: thread.id,
	};
}

export function syncThreadManagerScope(ctx: ExtensionContext, manager: ThreadManager): void {
	if (typeof manager.hydrateFromSession === "function") manager.hydrateFromSession(ctx);
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile !== undefined) {
		const managedThread = manager.findBySessionFile(sessionFile);
		if (managedThread !== undefined) {
			manager.rebindScope(scopeForThread(managedThread));
			return;
		}
	}

	manager.resetScope();
}

export function getThreadsSessionShutdownAction(
	event: SessionShutdownEvent,
	ctx: ExtensionContext,
	manager: ThreadManager,
): ThreadsSessionShutdownAction {
	if (event.reason !== "resume") return { kind: "shutdown" };
	const targetSessionFile = event.targetSessionFile;
	if (targetSessionFile === undefined) return { kind: "shutdown" };

	const targetThread = manager.findBySessionFile(targetSessionFile);
	if (targetThread !== undefined) {
		return targetThread.state === "live"
			? { kind: "stop_target", thread: targetThread }
			: { kind: "preserve" };
	}

	return { kind: "shutdown" };
}

export function shouldShutdownThreadsOnSessionShutdown(
	event: SessionShutdownEvent,
	ctx: ExtensionContext,
	manager: ThreadManager,
): boolean {
	return getThreadsSessionShutdownAction(event, ctx, manager).kind !== "preserve";
}

export async function prepareThreadsForSessionShutdown(
	event: SessionShutdownEvent,
	ctx: ExtensionContext,
	manager: ThreadManager,
): Promise<boolean> {
	const action = getThreadsSessionShutdownAction(event, ctx, manager);
	if (action.kind !== "stop_target") return action.kind === "shutdown";

	try {
		let outcome = await manager.stop({ action: "stop", id: action.thread.path, force: false });
		if (outcome.thread.state === "live") {
			outcome = await manager.stop({ action: "stop", id: action.thread.path, force: true });
		}
		if (outcome.thread.state === "live") {
			ctx.ui.notify(
				`Thread ${formatThreadTitle(action.thread)} is still live after stop; shutting down all managed threads before switching sessions.`,
				"warning",
			);
			return true;
		}
		return false;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(
			`Failed to stop live thread ${formatThreadTitle(action.thread)} before switching sessions: ${message}. Shutting down all managed threads.`,
			"warning",
		);
		return true;
	}
}

function appendThreadRegistrySnapshot(
	pi: ExtensionAPI,
	snapshot: ThreadSnapshot,
	scope: ThreadRegistryEntryScope | null,
	target: ThreadRegistryPersistenceTarget | null,
): void {
	const data = {
		version: 1,
		kind: "thread_snapshot",
		snapshot,
		...(scope === null ? {} : { scope }),
	};

	if (target === null || target.isCurrentSession) {
		if (typeof pi.appendEntry !== "function") return;
		pi.appendEntry(PI_THREAD_REGISTRY_ENTRY_TYPE, data);
		return;
	}

	if (target.sessionFile === null || !fs.existsSync(target.sessionFile)) return;
	SessionManager.open(target.sessionFile, target.sessionDir ?? undefined).appendCustomEntry(
		PI_THREAD_REGISTRY_ENTRY_TYPE,
		data,
	);
}

export default function (pi: ExtensionAPI) {
	const manager = getProcessManager();
	if (typeof manager.setPersistence === "function") {
		manager.setPersistence({
			appendSnapshot: (snapshot, scope, target) =>
				appendThreadRegistrySnapshot(pi, snapshot, scope, target),
		});
	}

	registerThreadsCommand(pi, manager, {
		beforeUse: (ctx) => syncThreadManagerScope(ctx, manager),
	});

	pi.on("session_start", (_event, ctx) => {
		syncThreadManagerScope(ctx, manager);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!(await prepareThreadsForSessionShutdown(event, ctx, manager))) return;
		await manager.shutdown();
		clearProcessManager(manager);
	});

	pi.registerTool({
		name: "thread",
		label: "Thread",
		description: PI_THREAD_DESCRIPTION,
		parameters: PiThreadParamsSchema,

		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			syncThreadManagerScope(ctx, manager);
			throwIfAborted(signal);
			assertPiThreadParams(rawParams);
			const params = rawParams;

			switch (params.action) {
				case "start": {
					const outcome = await manager.start(params, ctx);
					return {
						content: [{ type: "text", text: formatStart(outcome) }],
						details: withThreadResultDetails(outcome),
					};
				}
				case "list": {
					const threads = manager.list(params);
					return {
						content: [{ type: "text", text: formatList(threads) }],
						details: listResultDetails(threads),
					};
				}
				case "poll": {
					const thread = await manager.poll(params.id);
					const detail = params.detail ?? DEFAULT_THREAD_DETAIL;
					return {
						content: [{ type: "text", text: formatPoll(thread, detail) }],
						details: withThreadResultDetails({ kind: "polled", thread }, detail),
					};
				}
				case "send": {
					const outcome = await manager.send(params);
					return {
						content: [{ type: "text", text: formatSend(outcome) }],
						details: withThreadResultDetails(outcome),
					};
				}
				case "stop": {
					const outcome = await manager.stop(params);
					return {
						content: [{ type: "text", text: formatStop(outcome) }],
						details: withThreadResultDetails(outcome),
					};
				}
				case "resume": {
					const outcome = await manager.resume(params, ctx);
					return {
						content: [{ type: "text", text: formatResume(outcome) }],
						details: withThreadResultDetails(outcome),
					};
				}
				case "fork": {
					const outcome = await manager.fork(params, ctx);
					return {
						content: [{ type: "text", text: formatFork(outcome) }],
						details: withThreadResultDetails(outcome),
					};
				}
				case "archive": {
					const outcome = manager.archive(params);
					return {
						content: [{ type: "text", text: formatArchive(outcome) }],
						details: withThreadResultDetails(outcome),
					};
				}
				case "wait": {
					const detail = params.detail ?? DEFAULT_THREAD_DETAIL;
					const waitOptions = {
						...(signal === undefined ? {} : { signal }),
						onProgress: (progress: WaitProgress) => {
							onUpdate?.({
								content: [{ type: "text", text: formatWaitProgress(progress) }],
								details: withThreadResultDetails({ kind: "waiting", ...progress }, detail),
							});
						},
					};
					const outcome = await manager.wait(params, waitOptions);
					return {
						content: [{ type: "text", text: formatWait(outcome, detail) }],
						details: withThreadResultDetails(outcome, detail),
					};
				}
				default:
					assertNever(params);
			}
		},

		renderCall(args, theme) {
			const action = typeof args["action"] === "string" ? args["action"] : "unknown";
			let text = theme.fg("toolTitle", theme.bold("thread")) + " " + theme.fg("accent", action);

			switch (action) {
				case "start": {
					const prompt = typeof args["prompt"] === "string" ? args["prompt"] : "";
					if (prompt) {
						const summary = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
						text += " " + theme.fg("dim", `"${summary}"`);
					}
					const taskName =
						"taskName" in args && typeof args["taskName"] === "string" ? args["taskName"] : "";
					if (taskName) text += " " + theme.fg("muted", `[${taskName}]`);
					break;
				}
				case "fork": {
					const id = typeof args["id"] === "string" ? args["id"] : "";
					const entryId = typeof args["entryId"] === "string" ? args["entryId"] : "";
					const taskName =
						"taskName" in args && typeof args["taskName"] === "string" ? args["taskName"] : "";
					if (id) text += " " + theme.fg("accent", id);
					if (entryId) text += " " + theme.fg("muted", `entry:${entryId}`);
					if (taskName) text += " " + theme.fg("muted", `[${taskName}]`);
					break;
				}
				case "poll":
				case "resume":
				case "archive":
				case "stop": {
					const id = typeof args["id"] === "string" ? args["id"] : "";
					if (id) text += " " + theme.fg("accent", id);
					const detail = typeof args["detail"] === "string" ? args["detail"] : "";
					if (action === "poll" && detail) text += " " + theme.fg("muted", detail);
					break;
				}
				case "send": {
					const id = typeof args["id"] === "string" ? args["id"] : "";
					const msg =
						"message" in args && typeof args["message"] === "string" ? args["message"] : "";
					const mode = "mode" in args && typeof args["mode"] === "string" ? args["mode"] : "";
					if (id) text += " " + theme.fg("accent", id);
					if (mode) {
						const shortMode =
							mode === "follow_up"
								? "f/u"
								: mode === "steer"
									? "s"
									: mode === "prompt"
										? "p"
										: mode;
						text += " " + theme.fg("muted", shortMode);
					}
					if (msg) {
						const summary = msg.length > 40 ? msg.slice(0, 37) + "..." : msg;
						text += " " + theme.fg("dim", `"${summary}"`);
					}
					break;
				}
				case "wait": {
					const id = typeof args["id"] === "string" ? args["id"] : "";
					if (id) text += " " + theme.fg("accent", id);
					const detail = typeof args["detail"] === "string" ? args["detail"] : "";
					if (detail) text += " " + theme.fg("muted", detail);
					const timeoutMs =
						"timeoutMs" in args && typeof args["timeoutMs"] === "number"
							? args["timeoutMs"]
							: undefined;
					if (timeoutMs !== undefined) {
						text += " " + theme.fg("muted", formatTimeoutMsForTitle(timeoutMs));
					}
					break;
				}
				case "list":
				default:
					break;
			}

			return new Text(text, 0, 0);
		},
	});
}
