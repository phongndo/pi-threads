import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const Strict = { additionalProperties: false } as const;

export const SendModeSchema = StringEnum(["prompt", "steer", "follow_up"] as const, {
	description: "Delivery mode. Omit for prompt when idle, follow_up when busy.",
});

export const ListStateSchema = StringEnum(["all", "live", "closed"] as const, {
	description: "Filter listed threads by runtime state.",
});

export const ForkTurnsSchema = Type.String({
	pattern: "^(none|all|[1-9][0-9]*)$",
	description: "Parent context to include: none, all, or recent N user turns.",
});

const TargetDescription = "Thread id, canonical path (/root/task), or unambiguous task name.";

export const StartCommandSchema = Type.Object(
	{
		action: Type.Literal("start", { description: "Start a new child Pi session." }),
		prompt: Type.String({
			minLength: 1,
			description: "Initial child task prompt.",
		}),
		name: Type.Optional(
			Type.String({ minLength: 1, description: "Display name for the child Pi session." }),
		),
		taskName: Type.Optional(
			Type.String({
				pattern: "^[a-z0-9][a-z0-9_]{0,63}$",
				description: "Stable lower_snake_case path segment.",
			}),
		),
		forkTurns: Type.Optional(ForkTurnsSchema),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description: "Extra Pi CLI args. RPC mode is enforced; one-shot modes are rejected.",
			}),
		),
		cwd: Type.Optional(
			Type.String({ minLength: 1, description: "Working directory for the child session." }),
		),
	},
	Strict,
);

const ListFields = {
	action: Type.Literal("list", {
		description: "List child Pi sessions.",
	}),
	state: Type.Optional(ListStateSchema),
} as const;

export const ListCommandSchema = Type.Union(
	[
		Type.Object(ListFields, Strict),
		Type.Object(
			{
				...ListFields,
				parent: Type.String({
					minLength: 1,
					description: "Only direct children of this path/thread.",
				}),
			},
			Strict,
		),
		Type.Object(
			{
				...ListFields,
				ancestor: Type.String({
					minLength: 1,
					description: "Only descendants of this path/thread.",
				}),
			},
			Strict,
		),
	],
	{
		description: "List children; parent and ancestor are mutually exclusive.",
	},
);

export const PollCommandSchema = Type.Object(
	{
		action: Type.Literal("poll", { description: "Poll one child Pi session." }),
		id: Type.String({ minLength: 1, description: TargetDescription }),
	},
	Strict,
);

export const SendCommandSchema = Type.Object(
	{
		action: Type.Literal("send", { description: "Send a message to a child Pi session." }),
		id: Type.String({ minLength: 1, description: TargetDescription }),
		message: Type.String({ minLength: 1, description: "Message for the child." }),
		mode: Type.Optional(SendModeSchema),
	},
	Strict,
);

export const StopCommandSchema = Type.Object(
	{
		action: Type.Literal("stop", { description: "Stop a child Pi session." }),
		id: Type.String({ minLength: 1, description: TargetDescription }),
		force: Type.Optional(Type.Boolean({ description: "Use SIGKILL instead of graceful stop." })),
	},
	Strict,
);

export const WaitCommandSchema = Type.Object(
	{
		action: Type.Literal("wait", {
			description: "Wait until a child Pi session becomes idle, closes, or the timeout expires.",
		}),
		id: Type.String({ minLength: 1, description: TargetDescription }),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 600_000,
				description: "Max wait ms. Default 30000.",
			}),
		),
	},
	Strict,
);

export const PiThreadParamsSchema = Type.Union(
	[
		StartCommandSchema,
		ListCommandSchema,
		PollCommandSchema,
		SendCommandSchema,
		StopCommandSchema,
		WaitCommandSchema,
	],
	{
		description: "Strict action union: start, list, poll, send, wait, stop.",
	},
);

export type SendMode = Static<typeof SendModeSchema>;
export type ListState = Static<typeof ListStateSchema>;
export type StartCommand = Static<typeof StartCommandSchema>;
export type ListCommand = Static<typeof ListCommandSchema>;
export type PollCommand = Static<typeof PollCommandSchema>;
export type SendCommand = Static<typeof SendCommandSchema>;
export type StopCommand = Static<typeof StopCommandSchema>;
export type WaitCommand = Static<typeof WaitCommandSchema>;
export type PiThreadParams = Static<typeof PiThreadParamsSchema>;
