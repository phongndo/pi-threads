import {
	isThreadExitFailed,
	isThreadRunning,
	nextSuggestedThreadActions,
	threadPathBasename,
	type ThreadEvent,
	type ThreadExit,
	type ThreadSnapshot,
} from "./domain.ts";
import type {
	SendOutcome,
	StartOutcome,
	StopOutcome,
	WaitOutcome,
	WaitProgress,
} from "./thread-manager.ts";

export function formatStart(outcome: StartOutcome): string {
	const title = formatThreadTitle(outcome.thread);
	const lines = [
		`Started Pi thread "${title}".`,
		`Path: ${outcome.thread.path}`,
		`ID: ${outcome.thread.id}`,
		`Status: ${formatStatus(outcome.thread)}`,
		`Prompt accepted: ${outcome.promptAccepted ? "yes" : "no"}`,
	];
	if (outcome.note !== null) lines.push(`Note: ${outcome.note}`);
	lines.push(`Poll with: { "action": "poll", "id": "${outcome.thread.path}" }`);
	return lines.join("\n");
}

export function formatList(threads: readonly ThreadSnapshot[]): string {
	if (threads.length === 0) return "No Pi threads are managed by this parent session.";
	return threads
		.map(
			(thread) =>
				`${formatThreadTitle(thread)} ${thread.path} - ${formatStatus(thread)} [id: ${thread.id}]`,
		)
		.join("\n");
}

export function formatPoll(thread: ThreadSnapshot): string {
	const title = formatThreadTitle(thread);
	const lines = [
		`Pi thread "${title}"`,
		`Path: ${thread.path}`,
		`ID: ${thread.id}`,
		`Parent: ${thread.parentPath}${thread.parentThreadId ? ` (${thread.parentThreadId})` : ""}`,
		`Depth: ${thread.depth}`,
		`Status: ${formatStatus(thread)}`,
		`Running: ${isThreadRunning(thread) ? "yes" : "no"}`,
		formatNextLine(thread),
		`Cwd: ${thread.cwd}`,
	];
	if (thread.session.kind === "known") lines.push(`Session: ${thread.session.file}`);

	const text =
		thread.state === "live"
			? (thread.lastPartialText ?? thread.lastAssistantText)
			: thread.lastAssistantText;
	if (text !== null && text.trim() !== "") {
		lines.push("", "Last assistant output:", trimForDisplay(text, 4_000));
	}

	if (thread.recentEvents.length > 0) {
		lines.push("", "Recent events:");
		for (const event of thread.recentEvents.slice(-8)) lines.push(`- ${formatThreadEvent(event)}`);
	}

	if (thread.stderrTail.trim() !== "") {
		lines.push("", "stderr tail:", trimForDisplay(thread.stderrTail, 2_000));
	}

	return lines.join("\n");
}

export function formatSend(outcome: SendOutcome): string {
	const lines = [
		`Sent message to "${formatThreadTitle(outcome.thread)}" with mode ${outcome.mode}.`,
		`Path: ${outcome.thread.path}`,
		`Accepted: ${outcome.accepted ? "yes" : "no"}`,
		`Status: ${formatStatus(outcome.thread)}`,
	];
	if (outcome.error !== null) lines.push(`Error: ${outcome.error}`);
	return lines.join("\n");
}

export function formatStop(outcome: StopOutcome): string {
	return `Stopped "${formatThreadTitle(outcome.thread)}".\nPath: ${outcome.thread.path}\nStatus: ${formatStatus(outcome.thread)}`;
}

export function formatWait(outcome: WaitOutcome): string {
	const status = outcome.timedOut ? "timed out" : "completed";
	return [
		`Wait ${status} after ${outcome.waitedMs}ms for "${formatThreadTitle(outcome.thread)}".`,
		`Path: ${outcome.thread.path}`,
		`Status: ${formatStatus(outcome.thread)}`,
		`Running: ${isThreadRunning(outcome.thread) ? "yes" : "no"}`,
		formatNextLine(outcome.thread),
	].join("\n");
}

export function formatWaitProgress(progress: WaitProgress): string {
	return [
		`Waiting ${progress.waitedMs}ms for "${formatThreadTitle(progress.thread)}".`,
		`Path: ${progress.thread.path}`,
		`Status: ${formatStatus(progress.thread)}`,
		`Running: ${isThreadRunning(progress.thread) ? "yes" : "no"}`,
		formatNextLine(progress.thread),
	].join("\n");
}

export function nextThreadActions(thread: ThreadSnapshot): readonly string[] {
	return nextSuggestedThreadActions(thread);
}

function formatStatus(thread: ThreadSnapshot): string {
	if (thread.state === "closed") {
		if (isThreadExitFailed(thread.exit)) return "closed/failed";
		return `closed/${thread.exit.kind}`;
	}

	return `live/${thread.phase} pid=${thread.pid}`;
}

export function formatThreadEvent(event: ThreadEvent): string {
	const prefix = `${event.at} #${event.seq}`;
	switch (event.type) {
		case "thread_started":
			return `${prefix} thread started pid=${event.pid}`;
		case "thread_stopping":
			return `${prefix} thread stopping`;
		case "turn_started":
			return `${prefix} turn started`;
		case "turn_completed":
			return `${prefix} turn completed`;
		case "tool_started":
			return `${prefix} tool started: ${event.toolName}`;
		case "tool_completed":
			return `${prefix} tool completed: ${event.toolName}${event.error ? " (error)" : ""}`;
		case "assistant_message":
			return `${prefix} assistant: ${trimForDisplay(event.text.replaceAll("\n", " "), 240)}`;
		case "ui_request":
			return `${prefix} ui ${event.method}${event.title ? `: ${event.title}` : ""}${event.autoCancelled ? " (auto-cancelled)" : ""}`;
		case "thread_closed":
			return `${prefix} thread closed: ${formatExit(event.exit)}`;
		case "thread_error":
			return `${prefix} error: ${event.message}`;
	}
}

function formatExit(exit: ThreadExit): string {
	switch (exit.kind) {
		case "failed":
			return `failed (${exit.message})`;
		case "exited":
		case "stopped": {
			const details = [
				exit.code === null ? null : `code ${exit.code}`,
				exit.signal === null ? null : `signal ${exit.signal}`,
			]
				.filter((part): part is string => part !== null)
				.join(", ");
			return details === "" ? exit.kind : `${exit.kind} (${details})`;
		}
	}
}

function formatNextLine(thread: ThreadSnapshot): string {
	if (thread.state === "closed") return "Next: review output or list threads";
	return `Next: ${formatActionList(nextThreadActions(thread))}`;
}

function formatActionList(actions: readonly string[]): string {
	if (actions.length === 0) return "none";
	if (actions.length === 1) return actions[0]!;
	return `${actions.slice(0, -1).join(", ")}, or ${actions[actions.length - 1]!}`;
}

export function formatThreadLabel(idText: string, threads: readonly ThreadSnapshot[]): string {
	// Try to find a thread by id, path, or taskName
	for (const t of threads) {
		if (t.id === idText || t.path === idText || t.taskName === idText || t.name === idText) {
			return formatThreadTitle(t);
		}
	}
	// Fall back to path basename or raw id
	if (idText.startsWith("/")) {
		return humanizeTaskName(idText.slice(idText.lastIndexOf("/") + 1));
	}
	return idText;
}

export function formatThreadTitle(thread: ThreadSnapshot): string {
	const sessionName =
		thread.session.kind === "known" ? cleanDisplayText(thread.session.name) : null;
	if (sessionName !== null) return sessionName;

	const explicitName = cleanDisplayText(thread.name);
	if (explicitName !== null && explicitName !== thread.id && explicitName !== thread.taskName) {
		return explicitName;
	}

	const taskName = cleanDisplayText(thread.taskName);
	if (taskName !== null && taskName !== thread.id) return humanizeTaskName(taskName);

	const basename = threadPathBasename(thread.path);
	if (basename !== thread.id) return humanizeTaskName(basename);

	return shortThreadId(thread.id);
}

export function formatThreadReference(thread: ThreadSnapshot): string {
	return `${formatThreadTitle(thread)} (${thread.path})`;
}

export function formatThreadUserStatus(
	thread: ThreadSnapshot,
): "working" | "idle" | "done" | "failed" {
	if (thread.state === "closed") return isThreadExitFailed(thread.exit) ? "failed" : "done";
	return thread.phase === "idle" ? "idle" : "working";
}

export function formatThreadStateBadge(
	thread: ThreadSnapshot,
	theme: { fg: (color: "error" | "dim" | "muted" | "warning" | "success", text: string) => string },
): string {
	if (thread.state === "closed") {
		if (isThreadExitFailed(thread.exit)) {
			return theme.fg("error", "✕");
		}
		return theme.fg("dim", "○");
	}

	switch (thread.phase) {
		case "starting":
			return theme.fg("muted", "◌");
		case "busy":
			return theme.fg("warning", "●");
		case "idle":
			return theme.fg("success", "●");
		case "stopping":
			return theme.fg("warning", "◌");
	}
}

export function formatThreadSummary(thread: ThreadSnapshot, maxLen?: number): string {
	const statePart =
		thread.state === "closed"
			? isThreadExitFailed(thread.exit)
				? "closed/failed"
				: `closed/${thread.exit.kind}`
			: `live/${thread.phase}`;
	const pidPart = thread.state === "live" ? ` pid=${thread.pid}` : "";

	const text =
		thread.state === "live"
			? (thread.lastPartialText ?? thread.lastAssistantText)
			: thread.lastAssistantText;

	let summary = `(${statePart}${pidPart})`;
	if (text && text.trim()) {
		const preview = text.trim().replaceAll("\n", " ");
		const truncated =
			maxLen && preview.length > maxLen ? preview.slice(0, maxLen - 3) + "..." : preview;
		summary += ` ${truncated}`;
	}
	return summary;
}

function trimForDisplay(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`;
}

function cleanDisplayText(value: string | null): string | null {
	if (value === null) return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function humanizeTaskName(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "") return trimmed;
	return trimmed.replaceAll("_", " ");
}

function shortThreadId(value: string): string {
	return value.startsWith("thread_") ? value.slice(0, "thread_".length + 6) : value;
}
