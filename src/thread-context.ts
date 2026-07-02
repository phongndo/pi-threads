import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadId, ThreadPath } from "./domain.ts";
import { isRecord, stringField } from "./json.ts";

export type ForkContextSummary = {
	readonly mode: "none" | "all" | "last_n";
	readonly requested: string;
	readonly includedMessages: number;
	readonly truncated: boolean;
	readonly characters: number;
};

export function buildInitialPrompt(input: {
	readonly prompt: string;
	readonly threadId: ThreadId;
	readonly threadPath: ThreadPath;
	readonly parentPath: ThreadPath;
	readonly forkContextText: string | null;
}): string {
	const lines = [
		"You are a child Pi thread started by the pi_thread tool.",
		`Thread id: ${input.threadId}`,
		`Canonical task path: ${input.threadPath}`,
		`Parent path: ${input.parentPath}`,
		"Work independently. When finished, provide a concise final answer for the parent thread to consume.",
	];

	if (input.forkContextText !== null) {
		lines.push(
			"",
			"Inherited parent context follows. Treat it as read-only background; your actual task is below.",
			input.forkContextText,
		);
	}

	lines.push("", "Initial task:", input.prompt);
	return lines.join("\n");
}

export function buildForkContext(
	ctx: ExtensionContext,
	requested: string,
	maxChars: number,
): { readonly text: string | null; readonly summary: ForkContextSummary } {
	const mode = forkContextMode(requested);
	if (mode.kind === "none") {
		return {
			text: null,
			summary: {
				mode: "none",
				requested,
				includedMessages: 0,
				truncated: false,
				characters: 0,
			},
		};
	}

	const branch = ctx.sessionManager.getBranch() as readonly unknown[];
	const messages = branch.flatMap((entry) => formatContextEntry(entry));
	const selected = mode.kind === "all" ? messages : selectLastUserTurns(messages, mode.turns);
	const body = selected.join("\n\n");
	const { text, truncated } = truncateTail(body, maxChars);
	const wrapped =
		text.trim() === ""
			? null
			: `<parent_context fork_turns="${requested}">\n${text}\n</parent_context>`;

	return {
		text: wrapped,
		summary: {
			mode: mode.kind === "all" ? "all" : "last_n",
			requested,
			includedMessages: selected.length,
			truncated,
			characters: wrapped?.length ?? 0,
		},
	};
}

function forkContextMode(
	requested: string,
):
	| { readonly kind: "none" }
	| { readonly kind: "all" }
	| { readonly kind: "last_n"; readonly turns: number } {
	if (requested === "none") return { kind: "none" };
	if (requested === "all") return { kind: "all" };
	const turns = Number.parseInt(requested, 10);
	if (Number.isFinite(turns) && turns > 0) return { kind: "last_n", turns };
	throw new Error("forkTurns must be `none`, `all`, or a positive integer string");
}

function formatContextEntry(entry: unknown): readonly string[] {
	if (!isRecord(entry) || entry["type"] !== "message" || !isRecord(entry["message"])) return [];
	const message = entry["message"];
	const role = stringField(message, "role") ?? "message";
	const text = messageToText(message);
	if (text.trim() === "") return [];

	const toolName = role === "toolResult" ? stringField(message, "toolName") : null;
	const label = toolName === null ? role : `${role}:${toolName}`;
	return [`[${label}]\n${trimContextMessage(text)}`];
}

function messageToText(message: Record<string, unknown>): string {
	const content = message["content"];
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (!isRecord(part)) continue;
			const type = stringField(part, "type");
			if (type === "text") {
				const text = stringField(part, "text");
				if (text !== null) parts.push(text);
			} else if (type === "toolCall") {
				parts.push(`[tool call: ${stringField(part, "name") ?? "unknown"}]`);
			} else if (type === "image" || type === "localImage") {
				parts.push(`[${type}]`);
			}
		}
		return parts.join("\n");
	}

	if (typeof message["output"] === "string") return message["output"];
	return "";
}

function selectLastUserTurns(messages: readonly string[], turns: number): readonly string[] {
	let seenUserTurns = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.startsWith("[user]\n") === true) {
			seenUserTurns += 1;
			if (seenUserTurns === turns) return messages.slice(index);
		}
	}

	return messages;
}

function trimContextMessage(text: string): string {
	const maxMessageChars = 4_000;
	if (text.length <= maxMessageChars) return text;
	return `${text.slice(0, maxMessageChars)}\n[message truncated ${text.length - maxMessageChars} chars]`;
}

function truncateTail(
	text: string,
	maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	if (maxChars <= 0)
		return {
			text: "[parent context omitted by PI_THREADS_FORK_CONTEXT_MAX_CHARS]",
			truncated: true,
		};
	const omitted = text.length - maxChars;
	return {
		text: `[parent context truncated ${omitted} chars]\n${text.slice(-maxChars)}`,
		truncated: true,
	};
}
