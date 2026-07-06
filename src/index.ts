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
	isThreadIdText,
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
	type ThreadRegistryEntryScope,
	type ThreadRegistryPersistenceTarget,
	type ThreadManagerScope,
	type WaitProgress,
} from "./thread-manager.ts";

export const PI_THREAD_DESCRIPTION = "Start and manage background Pi child sessions.";

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

function compactInlineText(value: string, maxLength: number): string {
	let safe = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		safe += code < 0x20 || code === 0x7f ? " " : char;
	}
	const compact = safe.replace(/\s+/gu, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function quotedPreview(value: string, maxLength = 48): string {
	const preview = compactInlineText(value, maxLength).replace(/["\\]/gu, "\\$&");
	return `"${preview}"`;
}

function compactThreadReference(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "") return "";

	const withoutTrailingSlash = trimmed.length > 1 ? trimmed.replace(/\/+$/u, "") : trimmed;
	if (isThreadIdText(withoutTrailingSlash)) {
		return withoutTrailingSlash.slice(0, 13);
	}

	if (!withoutTrailingSlash.includes("/")) return compactInlineText(withoutTrailingSlash, 48);
	const parts = withoutTrailingSlash.split("/").filter((part) => part !== "");
	return compactInlineText(parts[parts.length - 1] ?? withoutTrailingSlash, 48);
}

function stringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	return typeof value === "string" ? value : "";
}

function threadCallActionLabel(args: Record<string, unknown>, action: string): string {
	return action === "archive" && args["archived"] === false ? "unarchive" : action;
}

function threadCallTarget(args: Record<string, unknown>, action: string): string {
	switch (action) {
		case "poll":
		case "wait":
		case "send":
		case "stop":
		case "resume":
		case "archive":
		case "fork":
			return compactThreadReference(stringArg(args, "id"));
		default:
			return "";
	}
}

function threadCallPreview(args: Record<string, unknown>, action: string): string {
	if (action !== "start") return "";
	const name = stringArg(args, "name");
	if (name !== "") return quotedPreview(name);
	const prompt = stringArg(args, "prompt");
	return prompt === "" ? "" : quotedPreview(prompt);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error("Thread action aborted");
}

// ---- Extension entrypoint ----

type ThreadsSessionShutdownAction =
	| { readonly kind: "shutdown" }
	| { readonly kind: "preserve" }
	| { readonly kind: "stop_target"; readonly thread: ThreadSnapshot };

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
	// The manager lives on globalThis, so after an in-place extension upgrade this
	// can be an instance built by an older module version; feature-check methods
	// that newer versions added before calling them.
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
	manager: ThreadManager,
): boolean {
	return getThreadsSessionShutdownAction(event, manager).kind !== "preserve";
}

export async function prepareThreadsForSessionShutdown(
	event: SessionShutdownEvent,
	ctx: ExtensionContext,
	manager: ThreadManager,
): Promise<boolean> {
	const action = getThreadsSessionShutdownAction(event, manager);
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
		// Registered closures keep referencing this manager after the global is
		// cleared, so forget the closed threads too — otherwise a later session in
		// the same process would still list this session's threads.
		if (typeof manager.clearThreads === "function") manager.clearThreads();
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
			const label = threadCallActionLabel(args, action);
			let text = theme.fg("toolTitle", theme.bold("thread")) + " " + theme.fg("accent", label);

			const target = threadCallTarget(args, action);
			if (target !== "") text += " " + theme.fg("accent", target);

			if (action === "stop" && args["force"] === true) text += " " + theme.fg("warning", "force");

			const preview = threadCallPreview(args, action);
			if (preview !== "") text += " " + theme.fg("dim", preview);

			return new Text(text, 0, 0);
		},
	});
}
