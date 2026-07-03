import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { asThreadId, asThreadPath } from "../src/domain.ts";
import { buildForkContext, buildInitialPrompt } from "../src/thread-context.ts";

function ctx(branch: readonly unknown[]): ExtensionContext {
	return {
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
}

function message(role: string, content: string): unknown {
	return { type: "message", message: { role, content } };
}

function toolResult(toolName: string, output: string): unknown {
	return { type: "message", message: { role: "toolResult", toolName, output } };
}

describe("buildForkContext", () => {
	it("omits inherited context for none", () => {
		const result = buildForkContext(ctx([message("user", "ignored")]), "none", 1_000);

		expect(result).toEqual({
			text: null,
			summary: {
				mode: "none",
				requested: "none",
				includedMessages: 0,
				truncated: false,
				characters: 0,
			},
		});
	});

	it("formats all non-empty parent messages", () => {
		const result = buildForkContext(
			ctx([
				{ type: "custom_message", content: "ignored" },
				message("user", "hello"),
				message("assistant", "hi"),
				toolResult("exec", "done"),
				message("user", "  \n"),
			]),
			"all",
			1_000,
		);

		const text = [
			'<parent_context fork_turns="all">',
			"[user]\nhello",
			"",
			"[assistant]\nhi",
			"",
			"[toolResult:exec]\ndone",
			"</parent_context>",
		].join("\n");
		expect(result.text).toBe(text);
		expect(result.summary).toEqual({
			mode: "all",
			requested: "all",
			includedMessages: 3,
			truncated: false,
			characters: text.length,
		});
	});

	it("walks backward for last_n user turns without formatting older entries", () => {
		const olderEntry = new Proxy(
			{ type: "message", message: { role: "user", content: "old" } },
			{
				get() {
					throw new Error("older entry should not be read");
				},
			},
		);

		const result = buildForkContext(
			ctx([
				olderEntry,
				message("assistant", "also old"),
				message("user", "first included"),
				message("assistant", "after first"),
				message("user", "second included"),
				message("assistant", "after second"),
			]),
			"2",
			1_000,
		);

		const text = [
			'<parent_context fork_turns="2">',
			"[user]\nfirst included",
			"",
			"[assistant]\nafter first",
			"",
			"[user]\nsecond included",
			"",
			"[assistant]\nafter second",
			"</parent_context>",
		].join("\n");
		expect(result.text).toBe(text);
		expect(result.summary).toEqual({
			mode: "last_n",
			requested: "2",
			includedMessages: 4,
			truncated: false,
			characters: text.length,
		});
	});

	it("truncates inherited context from the tail", () => {
		const body = "[user]\n0123456789\n\n[assistant]\nabcdefghij";
		const maxChars = 12;
		const result = buildForkContext(
			ctx([message("user", "0123456789"), message("assistant", "abcdefghij")]),
			"all",
			maxChars,
		);

		const text = [
			'<parent_context fork_turns="all">',
			`[parent context truncated ${body.length - maxChars} chars]`,
			body.slice(-maxChars),
			"</parent_context>",
		].join("\n");
		expect(result.text).toBe(text);
		expect(result.summary).toEqual({
			mode: "all",
			requested: "all",
			includedMessages: 2,
			truncated: true,
			characters: text.length,
		});
	});
});

describe("buildInitialPrompt", () => {
	it("builds the child prompt without inherited context", () => {
		const prompt = buildInitialPrompt({
			prompt: "Review the tests.",
			threadId: asThreadId("thread_012345abcdef"),
			threadPath: asThreadPath("/root/review_tests"),
			parentPath: asThreadPath("/root"),
			forkContextText: null,
		});

		expect(prompt).toBe(
			[
				"You are a child Pi thread started by the thread tool.",
				"Thread id: thread_012345abcdef",
				"Canonical task path: /root/review_tests",
				"Parent path: /root",
				"Work independently. When finished, provide a concise final answer for the parent thread to consume.",
				"",
				"Initial task:",
				"Review the tests.",
			].join("\n"),
		);
	});

	it("includes inherited context before the initial task", () => {
		const prompt = buildInitialPrompt({
			prompt: "Continue.",
			threadId: asThreadId("thread_012345abcdef"),
			threadPath: asThreadPath("/root/continue"),
			parentPath: asThreadPath("/root"),
			forkContextText: '<parent_context fork_turns="1">\n[user]\nhi\n</parent_context>',
		});

		expect(prompt).toContain(
			[
				"Inherited parent context follows. Treat it as read-only background; your actual task is below.",
				'<parent_context fork_turns="1">\n[user]\nhi\n</parent_context>',
				"",
				"Initial task:",
				"Continue.",
			].join("\n"),
		);
	});
});
