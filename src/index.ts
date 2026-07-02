import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { assertNever, type ThreadEvent, type ThreadSnapshot } from "./domain.ts";
import {
	formatList,
	formatPoll,
	formatSend,
	formatStart,
	formatStop,
	formatWait,
} from "./format.ts";
import { assertPiThreadParams, PiThreadParamsSchema } from "./schema.ts";
import {
	ThreadManager,
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

// ---- Extension entrypoint ----

export default function (pi: ExtensionAPI) {
	const manager = new ThreadManager();

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});

	pi.registerTool({
		name: "thread",
		label: "Thread",
		description: PI_THREAD_DESCRIPTION,
		promptSnippet: PI_THREAD_PROMPT_SNIPPET,
		promptGuidelines: [...PI_THREAD_PROMPT_GUIDELINES],
		parameters: PiThreadParamsSchema,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
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
					const id = "id" in args && typeof args["id"] === "string" ? args["id"] : "";
					if (id) text += " " + theme.fg("dim", id);
					break;
				}
				case "send": {
					const id = "id" in args && typeof args["id"] === "string" ? args["id"] : "";
					const msg =
						"message" in args && typeof args["message"] === "string" ? args["message"] : "";
					const mode = "mode" in args && typeof args["mode"] === "string" ? args["mode"] : "";
					if (id) text += " " + theme.fg("dim", id);
					if (mode) text += " " + theme.fg("muted", mode);
					if (msg) {
						const summary = msg.length > 40 ? msg.slice(0, 37) + "..." : msg;
						text += " " + theme.fg("dim", `"${summary}"`);
					}
					break;
				}
				case "wait": {
					const id = "id" in args && typeof args["id"] === "string" ? args["id"] : "";
					if (id) text += " " + theme.fg("dim", id);
					const timeoutMs =
						"timeoutMs" in args && typeof args["timeoutMs"] === "number"
							? args["timeoutMs"]
							: undefined;
					if (timeoutMs !== undefined) text += " " + theme.fg("muted", `${timeoutMs}ms`);
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
					const lines = [
						`  State:  ${formatThreadState(outcome.thread, theme)}`,
						`  ID:     ${theme.fg("dim", outcome.thread.id)}`,
					];
					if (expanded) {
						lines.push(
							`  Path:   ${theme.fg("dim", outcome.thread.path)}`,
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
					const lines = [`  ${threads.length} thread${threads.length === 1 ? "" : "s"}`];
					if (expanded) {
						for (const t of threads) {
							lines.push(
								`  ${theme.fg("dim", t.id)} ${theme.fg("muted", t.path)} ${formatThreadState(t, theme)}`,
							);
							const preview = formatLastOutput(t, 60);
							if (preview) lines.push(`    ${theme.fg("dim", `"${preview}"`)}`);
						}
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
					const lines = [`  State:  ${formatThreadState(thread, theme)}`];
					if (expanded) {
						lines.push(`  Path:   ${theme.fg("dim", thread.path)}`);
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
					const lines: string[] = [];
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
					return new Text(`  ${formatThreadState(outcome.thread, theme)}`, 0, 0);
				}

				case "waited": {
					const outcome = details as WaitOutcome;
					const lines: string[] = [];
					if (outcome.timedOut) {
						lines.push(`  ${theme.fg("warning", `Timed out after ${outcome.waitedMs}ms`)}`);
					} else {
						lines.push(`  ${theme.fg("success", `Completed in ${outcome.waitedMs}ms`)}`);
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
