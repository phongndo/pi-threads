import type { ThreadEvent, ThreadSnapshot } from "./domain.ts";
import type { SendOutcome, StartOutcome, StopOutcome, WaitOutcome } from "./thread-manager.ts";

export function formatStart(outcome: StartOutcome): string {
	const lines = [
		`Started Pi thread ${outcome.thread.id} (${outcome.thread.name}).`,
		`Path: ${outcome.thread.path}`,
		`Status: ${formatStatus(outcome.thread)}`,
		`Prompt accepted: ${outcome.promptAccepted ? "yes" : "no"}`,
	];
	if (outcome.forkContext.mode !== "none") {
		lines.push(
			`Fork context: ${outcome.forkContext.requested} (${outcome.forkContext.includedMessages} messages${outcome.forkContext.truncated ? ", truncated" : ""})`,
		);
	}
	if (outcome.note !== null) lines.push(`Note: ${outcome.note}`);
	lines.push(`Poll with: { "action": "poll", "id": "${outcome.thread.id}" }`);
	return lines.join("\n");
}

export function formatList(threads: readonly ThreadSnapshot[]): string {
	if (threads.length === 0) return "No Pi threads are managed by this parent session.";
	return threads
		.map((thread) => `${thread.id} ${thread.path} (${thread.name}) - ${formatStatus(thread)}`)
		.join("\n");
}

export function formatPoll(thread: ThreadSnapshot): string {
	const lines = [
		`Pi thread ${thread.id} (${thread.name})`,
		`Path: ${thread.path}`,
		`Parent: ${thread.parentPath}${thread.parentThreadId ? ` (${thread.parentThreadId})` : ""}`,
		`Depth: ${thread.depth}`,
		`Status: ${formatStatus(thread)}`,
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
		for (const event of thread.recentEvents.slice(-8)) lines.push(`- ${formatEvent(event)}`);
	}

	if (thread.stderrTail.trim() !== "") {
		lines.push("", "stderr tail:", trimForDisplay(thread.stderrTail, 2_000));
	}

	return lines.join("\n");
}

export function formatSend(outcome: SendOutcome): string {
	const lines = [
		`Sent message to ${outcome.thread.id} with mode ${outcome.mode}.`,
		`Accepted: ${outcome.accepted ? "yes" : "no"}`,
		`Status: ${formatStatus(outcome.thread)}`,
	];
	if (outcome.error !== null) lines.push(`Error: ${outcome.error}`);
	return lines.join("\n");
}

export function formatStop(outcome: StopOutcome): string {
	return `Stopped ${outcome.thread.id}.\nStatus: ${formatStatus(outcome.thread)}`;
}

export function formatWait(outcome: WaitOutcome): string {
	const status = outcome.timedOut ? "timed out" : "completed";
	return `Wait ${status} after ${outcome.waitedMs}ms for ${outcome.thread.id}.\nStatus: ${formatStatus(outcome.thread)}`;
}

function formatStatus(thread: ThreadSnapshot): string {
	if (thread.state === "closed") {
		return `closed/${thread.exit.kind}`;
	}

	return `live/${thread.phase} pid=${thread.pid}`;
}

function formatEvent(event: ThreadEvent): string {
	switch (event.kind) {
		case "state":
			return `${event.at} state: ${event.message}`;
		case "assistant":
			return `${event.at} assistant: ${trimForDisplay(event.text.replaceAll("\n", " "), 240)}`;
		case "tool":
			return `${event.at} tool ${event.phase}: ${event.name}${event.error ? " (error)" : ""}`;
		case "ui":
			return `${event.at} ui ${event.method}${event.title ? `: ${event.title}` : ""}${event.autoCancelled ? " (auto-cancelled)" : ""}`;
		case "error":
			return `${event.at} error: ${event.message}`;
	}
}

function trimForDisplay(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`;
}
