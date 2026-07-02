import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { assertNever } from "./domain.ts";
import {
	formatList,
	formatPoll,
	formatSend,
	formatStart,
	formatStop,
	formatWait,
} from "./format.ts";
import { assertPiThreadParams, PiThreadParamsSchema } from "./schema.ts";
import { ThreadManager } from "./thread-manager.ts";
import {
	PI_THREAD_DESCRIPTION,
	PI_THREAD_PROMPT_GUIDELINES,
	PI_THREAD_PROMPT_SNIPPET,
} from "./prompt.ts";

export default function (pi: ExtensionAPI) {
	const manager = new ThreadManager();

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});

	pi.registerTool({
		name: "pi_thread",
		label: "Pi Thread",
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
			const action = typeof args.action === "string" ? args.action : "unknown";
			const id = "id" in args && typeof args.id === "string" ? ` ${args.id}` : "";
			const name = "name" in args && typeof args.name === "string" ? ` ${args.name}` : "";
			const taskName =
				"taskName" in args && typeof args.taskName === "string" ? ` ${args.taskName}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("pi_thread"))} ${theme.fg("accent", action)}${id}${taskName}${name}`,
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
