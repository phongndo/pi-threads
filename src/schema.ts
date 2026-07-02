import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const Strict = { additionalProperties: false } as const;

export const SendModeSchema = StringEnum(["prompt", "steer", "follow_up"] as const, {
	description:
		"How to deliver a message to the child session. Omit to send immediately when idle and follow_up when busy.",
});

export const StartCommandSchema = Type.Object(
	{
		action: Type.Literal("start", { description: "Start a new child Pi session." }),
		prompt: Type.String({
			minLength: 1,
			description: "Initial prompt to send to the child Pi session.",
		}),
		name: Type.Optional(
			Type.String({ minLength: 1, description: "Display name for the child Pi session." }),
		),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Additional Pi CLI args. RPC mode is enforced and one-shot modes such as --print are rejected.",
			}),
		),
		cwd: Type.Optional(
			Type.String({ minLength: 1, description: "Working directory for the child session." }),
		),
	},
	Strict,
);

export const ListCommandSchema = Type.Object(
	{
		action: Type.Literal("list", {
			description: "List child Pi sessions managed by this parent session.",
		}),
	},
	Strict,
);

export const PollCommandSchema = Type.Object(
	{
		action: Type.Literal("poll", { description: "Poll one child Pi session." }),
		id: Type.String({ minLength: 1, description: "Thread id returned by start or list." }),
	},
	Strict,
);

export const SendCommandSchema = Type.Object(
	{
		action: Type.Literal("send", { description: "Send a message to a child Pi session." }),
		id: Type.String({ minLength: 1, description: "Thread id returned by start or list." }),
		message: Type.String({ minLength: 1, description: "Message to send to the child session." }),
		mode: Type.Optional(SendModeSchema),
	},
	Strict,
);

export const StopCommandSchema = Type.Object(
	{
		action: Type.Literal("stop", { description: "Stop a child Pi session." }),
		id: Type.String({ minLength: 1, description: "Thread id returned by start or list." }),
		force: Type.Optional(
			Type.Boolean({ description: "Use SIGKILL immediately instead of graceful termination." }),
		),
	},
	Strict,
);

export const PiThreadParamsSchema = Type.Union(
	[StartCommandSchema, ListCommandSchema, PollCommandSchema, SendCommandSchema, StopCommandSchema],
	{
		description:
			"Strict tagged union. Each action accepts only the fields for that action: start, list, poll, send, or stop.",
	},
);

export type SendMode = Static<typeof SendModeSchema>;
export type StartCommand = Static<typeof StartCommandSchema>;
export type ListCommand = Static<typeof ListCommandSchema>;
export type PollCommand = Static<typeof PollCommandSchema>;
export type SendCommand = Static<typeof SendCommandSchema>;
export type StopCommand = Static<typeof StopCommandSchema>;
export type PiThreadParams = Static<typeof PiThreadParamsSchema>;
