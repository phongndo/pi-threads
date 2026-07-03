import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	assertNever,
	asThreadId,
	asThreadPath,
	isThreadIdText,
	type ThreadEvent,
	type ThreadId,
	type ThreadPath,
	type ThreadSnapshot,
} from "./domain.ts";
import {
	formatList,
	formatPoll,
	formatSend,
	formatStart,
	formatStop,
	formatThreadLabel,
	formatThreadTitle,
	formatThreadStateBadge,
	formatThreadSummary,
	formatWait,
} from "./format.ts";
import { isRecord, stringField } from "./json.ts";
import { assertPiThreadParams, PiThreadParamsSchema } from "./schema.ts";
import { PI_THREAD_ENTRY_MESSAGE_TYPE, registerThreadsCommand } from "./threads-command.ts";
import {
	ThreadManager,
	type ThreadManagerScope,
	type SendOutcome,
	type StartOutcome,
	type StopOutcome,
	type WaitOutcome,
} from "./thread-manager.ts";
import {
	PI_THREAD_DESCRIPTION,
	PI_THREAD_PROMPT_GUIDELINES,
	PI_THREAD_PROMPT_SNIPPET,
} from "./prompt.ts";

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

// ---- Render helpers ----

function formatThreadState(thread: ThreadSnapshot, theme: Theme): string {
	if (thread.state === "closed") {
		const exitKind = thread.exit.kind;
		if (exitKind === "failed") {
			return theme.fg("error", `closed/${exitKind}: ${thread.exit.message}`);
		}
		let status = `closed/${exitKind}`;
		if (thread.exit.code !== null) status += ` code=${thread.exit.code}`;
		if (thread.exit.signal !== null) status += ` sig=${thread.exit.signal}`;
		return theme.fg("dim", status);
	}

	switch (thread.phase) {
		case "starting":
			return theme.fg("muted", `live/starting pid=${thread.pid}`);
		case "busy":
			return theme.fg("accent", `live/busy pid=${thread.pid}`);
		case "idle":
			return theme.fg("success", `live/idle pid=${thread.pid}`);
		case "stopping":
			return theme.fg("warning", `live/stopping pid=${thread.pid}`);
	}
}

function formatLastOutput(thread: ThreadSnapshot, maxLen: number): string | null {
	const text =
		thread.state === "live"
			? (thread.lastPartialText ?? thread.lastAssistantText)
			: thread.lastAssistantText;
	if (!text || text.trim() === "") return null;
	const trimmed = text.trim().replaceAll("\n", " ");
	if (trimmed.length <= maxLen) return trimmed;
	return trimmed.slice(0, maxLen - 3) + "...";
}

function formatEvents(events: readonly ThreadEvent[], maxCount: number): string[] {
	return events.slice(-maxCount).map((event) => {
		const at = event.at.slice(11, 19);
		switch (event.kind) {
			case "state":
				return `${at}  ${event.message}`;
			case "assistant":
				return `${at}  "${event.text.slice(0, 80).replaceAll("\n", " ")}"`;
			case "tool":
				return `${at}  tool: ${event.name} (${event.phase})${event.error ? " error" : ""}`;
			case "ui":
				return `${at}  ui: ${event.method}${event.title ? ` - ${event.title}` : ""}`;
			case "error":
				return `${at}  error: ${event.message}`;
		}
	});
}

function formatTimeoutMsForTitle(timeoutMs: number): string {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) return `${timeoutMs}ms`;
	const wholeSeconds = Math.trunc(timeoutMs / 1000);
	const milliseconds = timeoutMs % 1000;
	if (milliseconds === 0) return `${wholeSeconds}s`;
	const fractionalSeconds = String(milliseconds).padStart(3, "0").replace(/0+$/u, "");
	return `${wholeSeconds}.${fractionalSeconds}s`;
}

// ---- Extension entrypoint ----

type ThreadEntryDetails = {
	readonly parentSessionFile: string | null;
	readonly threadPath: ThreadPath | null;
	readonly threadId: ThreadId | null;
};

type ThreadsSessionShutdownAction =
	| { readonly kind: "shutdown" }
	| { readonly kind: "preserve" }
	| { readonly kind: "stop_target"; readonly thread: ThreadSnapshot };

function findThreadEntryDetails(ctx: ExtensionContext): ThreadEntryDetails | null {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!isRecord(entry) || entry["type"] !== "custom_message") continue;
		if (entry["customType"] !== PI_THREAD_ENTRY_MESSAGE_TYPE) continue;
		const details = entry["details"];
		if (!isRecord(details)) continue;
		const parentSessionFile = stringField(details, "parentSessionFile");
		const threadPathText = stringField(details, "threadPath");
		const threadIdText = stringField(details, "threadId");
		return {
			parentSessionFile,
			threadPath: threadPathText === null ? null : parseThreadPath(threadPathText),
			threadId: threadIdText === null ? null : parseThreadId(threadIdText),
		};
	}
	return null;
}

function findThreadParentSession(ctx: ExtensionContext): string | null {
	return findThreadEntryDetails(ctx)?.parentSessionFile ?? null;
}

function sameSessionFile(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}

function threadDepth(threadPath: ThreadPath): number {
	return Math.max(0, threadPath.split("/").filter(Boolean).length - 1);
}

function parseThreadPath(value: string): ThreadPath | null {
	try {
		return asThreadPath(value);
	} catch {
		return null;
	}
}

function parseThreadId(value: string): ThreadId | null {
	return isThreadIdText(value) ? asThreadId(value) : null;
}

function scopeForThread(thread: ThreadSnapshot): ThreadManagerScope {
	return {
		currentPath: thread.path,
		depth: thread.depth,
		selfThreadId: thread.id,
	};
}

export function syncThreadManagerScope(ctx: ExtensionContext, manager: ThreadManager): void {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile !== undefined) {
		const managedThread = manager.findBySessionFile(sessionFile);
		if (managedThread !== undefined) {
			manager.rebindScope(scopeForThread(managedThread));
			return;
		}
	}

	const entryDetails = findThreadEntryDetails(ctx);
	if (entryDetails !== null && entryDetails.threadPath !== null) {
		manager.rebindScope({
			currentPath: entryDetails.threadPath,
			depth: threadDepth(entryDetails.threadPath),
			selfThreadId: entryDetails.threadId,
		});
		return;
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

	const parentSessionFile = findThreadParentSession(ctx);
	if (parentSessionFile !== null && sameSessionFile(parentSessionFile, targetSessionFile)) {
		return { kind: "preserve" };
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

async function exitThreadSession(ctx: ExtensionCommandContext): Promise<void> {
	const parentSessionFile = findThreadParentSession(ctx);
	if (parentSessionFile === null) {
		ctx.ui.notify("No parent Pi thread session is recorded. Use /quit to quit Pi.", "warning");
		return;
	}
	await ctx.switchSession(parentSessionFile);
}

export default function (pi: ExtensionAPI) {
	const manager = getProcessManager();

	registerThreadsCommand(pi, manager, {
		beforeUse: (ctx) => syncThreadManagerScope(ctx, manager),
	});

	pi.on("session_start", (_event, ctx) => {
		syncThreadManagerScope(ctx, manager);
	});

	pi.registerMessageRenderer(PI_THREAD_ENTRY_MESSAGE_TYPE, (message, _options, theme) => {
		const text = typeof message.content === "string" ? message.content : "Entered Pi thread.";
		return new Text(theme.fg("muted", text), 1, 0);
	});

	pi.registerCommand("exit", {
		description: "Exit a Pi thread and return to the parent session",
		handler: async (_args, ctx) => exitThreadSession(ctx),
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
		promptSnippet: PI_THREAD_PROMPT_SNIPPET,
		promptGuidelines: [...PI_THREAD_PROMPT_GUIDELINES],
		parameters: PiThreadParamsSchema,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			syncThreadManagerScope(ctx, manager);
			assertPiThreadParams(rawParams);
			const params = rawParams;

			switch (params.action) {
				case "start": {
					const outcome = await manager.start(params, ctx);
					return {
						content: [{ type: "text", text: formatStart(outcome) }],
						details: outcome,
					};
				}
				case "list": {
					const threads = manager.list(params);
					return {
						content: [{ type: "text", text: formatList(threads) }],
						details: { kind: "listed", threads },
					};
				}
				case "poll": {
					const thread = await manager.poll(params.id);
					return {
						content: [{ type: "text", text: formatPoll(thread) }],
						details: { kind: "polled", thread },
					};
				}
				case "send": {
					const outcome = await manager.send(params);
					return {
						content: [{ type: "text", text: formatSend(outcome) }],
						details: outcome,
					};
				}
				case "stop": {
					const outcome = await manager.stop(params);
					return {
						content: [{ type: "text", text: formatStop(outcome) }],
						details: outcome,
					};
				}
				case "wait": {
					const outcome = await manager.wait(params);
					return {
						content: [{ type: "text", text: formatWait(outcome) }],
						details: outcome,
					};
				}
				default:
					assertNever(params);
			}
		},

		renderCall(args, theme) {
			const action = typeof args["action"] === "string" ? args["action"] : "unknown";
			let text = theme.fg("toolTitle", theme.bold("thread")) + " " + theme.fg("accent", action);

			const allThreads = manager.list({ action: "list", state: "all" });
			const id = typeof args["id"] === "string" ? args["id"] : "";
			const label = id ? formatThreadLabel(id, allThreads) : "";

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
					const forkTurns =
						"forkTurns" in args && typeof args["forkTurns"] === "string" ? args["forkTurns"] : "";
					if (forkTurns) text += " " + theme.fg("muted", `fork=${forkTurns}`);
					break;
				}
				case "poll":
				case "stop": {
					if (label) text += " " + theme.fg("accent", `"${label}"`);
					break;
				}
				case "send": {
					const msg =
						"message" in args && typeof args["message"] === "string" ? args["message"] : "";
					const mode = "mode" in args && typeof args["mode"] === "string" ? args["mode"] : "";
					if (label) text += " " + theme.fg("accent", `"${label}"`);
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
					if (label) text += " " + theme.fg("accent", `"${label}"`);
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

		renderResult(result, options, theme) {
			const details = result.details;
			if (!details || typeof details !== "object") {
				const first = result.content[0];
				const text = first?.type === "text" && first.text ? first.text : "(no output)";
				return new Text(theme.fg("toolOutput", text), 0, 0);
			}

			const d = details as Record<string, unknown>;
			const kind = typeof d["kind"] === "string" ? d["kind"] : "";
			const expanded = options?.expanded === true;

			switch (kind) {
				case "started": {
					const outcome = details as StartOutcome;
					const badge = formatThreadStateBadge(outcome.thread, theme);
					const lines = [
						`  ${badge} ${theme.fg("accent", formatThreadTitle(outcome.thread))}  ${formatThreadState(outcome.thread, theme)}`,
					];
					if (expanded) {
						lines.push(
							`  Path:   ${theme.fg("dim", outcome.thread.path)}`,
							`  ID:     ${theme.fg("dim", outcome.thread.id)}`,
							`  Prompt: ${outcome.promptAccepted ? theme.fg("success", "accepted") : theme.fg("warning", "not accepted")}`,
							`  Fork:   ${theme.fg("muted", outcome.forkContext.mode)}`,
						);
						if (outcome.note) lines.push(`  Note:   ${theme.fg("muted", outcome.note)}`);
					}
					return new Text(lines.join("\n"), 0, 0);
				}

				case "listed": {
					const threads = (
						details as {
							readonly kind: "listed";
							readonly threads: readonly ThreadSnapshot[];
						}
					).threads;
					if (!Array.isArray(threads)) {
						return new Text(theme.fg("dim", "No threads"), 0, 0);
					}
					const liveCount = threads.filter((t) => t.state === "live").length;
					const closedCount = threads.length - liveCount;
					const lines: string[] = [];
					if (expanded) {
						if (threads.length === 0) {
							lines.push(`  ${theme.fg("dim", "No threads")}`);
						} else {
							for (const t of threads) {
								const badge = formatThreadStateBadge(t, theme);
								const summary = formatThreadSummary(t, 80);
								lines.push(
									`  ${badge} ${theme.fg("accent", formatThreadTitle(t))}`,
									`    ${theme.fg("dim", t.path)}  ${theme.fg("dim", summary)}`,
								);
							}
						}
					} else {
						lines.push(
							`  ${threads.length} thread${threads.length === 1 ? "" : "s"} • ${liveCount} live, ${closedCount} closed`,
						);
					}
					return new Text(lines.join("\n"), 0, 0);
				}

				case "polled": {
					const thread = (
						details as {
							readonly kind: "polled";
							readonly thread: ThreadSnapshot;
						}
					).thread;
					if (!thread || typeof thread !== "object") {
						return new Text(theme.fg("error", "Invalid thread data"), 0, 0);
					}
					const badge = formatThreadStateBadge(thread, theme);
					const lines = [
						`  ${badge} ${theme.fg("accent", formatThreadTitle(thread))}  ${formatThreadState(thread, theme)}`,
					];
					if (expanded) {
						lines.push(`  Path:   ${theme.fg("dim", thread.path)}`);
						lines.push(`  ID:     ${theme.fg("dim", thread.id)}`);
						const lastOut = formatLastOutput(thread, 200);
						if (lastOut) lines.push(`  Last:   ${theme.fg("toolOutput", `"${lastOut}"`)}`);
						if (thread.recentEvents.length > 0) {
							lines.push("", `  ${theme.fg("muted", "Events:")}`);
							for (const eventLine of formatEvents(thread.recentEvents, 8)) {
								lines.push(`    ${theme.fg("dim", eventLine)}`);
							}
						}
						if (
							"stderrTail" in thread &&
							typeof thread.stderrTail === "string" &&
							thread.stderrTail.trim()
						) {
							lines.push("", `  ${theme.fg("warning", "stderr:")}`);
							lines.push(`    ${theme.fg("dim", thread.stderrTail.slice(0, 200).trimEnd())}`);
						}
					} else {
						const lastOut = formatLastOutput(thread, 80);
						if (lastOut) lines.push(`  Last:   ${theme.fg("toolOutput", `"${lastOut}"`)}`);
					}
					return new Text(lines.join("\n"), 0, 0);
				}

				case "sent": {
					const outcome = details as SendOutcome;
					const lines: string[] = [`  ${theme.fg("accent", formatThreadTitle(outcome.thread))}`];
					if (outcome.accepted) {
						lines.push(`  ${theme.fg("success", "Accepted")}`);
					} else {
						lines.push(`  ${theme.fg("error", "Rejected")}`);
						if (outcome.error) lines.push(`  ${theme.fg("warning", outcome.error)}`);
					}
					if (expanded) {
						lines.push(`  Mode:  ${theme.fg("muted", outcome.mode)}`);
						lines.push(`  State: ${formatThreadState(outcome.thread, theme)}`);
					}
					return new Text(lines.join("\n"), 0, 0);
				}

				case "stopped": {
					const outcome = details as StopOutcome;
					return new Text(
						`  ${theme.fg("accent", formatThreadTitle(outcome.thread))}  ${formatThreadState(outcome.thread, theme)}`,
						0,
						0,
					);
				}

				case "waited": {
					const outcome = details as WaitOutcome;
					const lines: string[] = [];
					if (outcome.timedOut) {
						lines.push(
							`  ${theme.fg("warning", `Timed out after ${outcome.waitedMs}ms`)} ${theme.fg("accent", formatThreadTitle(outcome.thread))}`,
						);
					} else {
						lines.push(
							`  ${theme.fg("success", `Completed in ${outcome.waitedMs}ms`)} ${theme.fg("accent", formatThreadTitle(outcome.thread))}`,
						);
					}
					if (expanded) {
						lines.push(`  State: ${formatThreadState(outcome.thread, theme)}`);
					}
					return new Text(lines.join("\n"), 0, 0);
				}

				default: {
					const first = result.content[0];
					const text = first?.type === "text" && first.text ? first.text : "(no output)";
					return new Text(theme.fg("toolOutput", text), 0, 0);
				}
			}
		},
	});
}
