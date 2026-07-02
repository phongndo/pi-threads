import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { assertNever } from "./domain.ts";
import { formatList, formatPoll, formatSend, formatStart, formatStop } from "./format.ts";
import { PiThreadParamsSchema, type PiThreadParams } from "./schema.ts";
import { ThreadManager } from "./thread-manager.ts";

export default function (pi: ExtensionAPI) {
	const manager = new ThreadManager();

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});

	pi.registerTool({
		name: "pi_thread",
		label: "Pi Thread",
		description:
			"Start, list, poll, message, and stop child Pi sessions. Input is a strict tagged union keyed by action.",
		promptSnippet:
			"Start, poll, message, list, or stop child Pi sessions for isolated or parallel work.",
		promptGuidelines: [
			"Use pi_thread when an independent Pi session would help with isolation, parallel investigation, review, or long-running work.",
			"Use pi_thread start with a small, concrete prompt; then use pi_thread poll before relying on the child output.",
			"Use pi_thread send for follow-up instructions and pi_thread stop for stale or unnecessary child sessions.",
			"Avoid runaway spawning: only create child Pi sessions that materially reduce risk, latency, or context pressure.",
		],
		parameters: PiThreadParamsSchema,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as PiThreadParams;

			switch (params.action) {
				case "start": {
					const outcome = await manager.start(params, ctx);
					return {
						content: [{ type: "text", text: formatStart(outcome) }],
						details: outcome,
					};
				}
				case "list": {
					const threads = manager.list();
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
				default:
					assertNever(params);
			}
		},

		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "unknown";
			const id = "id" in args && typeof args.id === "string" ? ` ${args.id}` : "";
			const name = "name" in args && typeof args.name === "string" ? ` ${args.name}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("pi_thread"))} ${theme.fg("accent", action)}${id}${name}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "(no output)";
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});
}
