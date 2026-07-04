import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const Strict = { additionalProperties: false } as const;
const ActionValues = ["start", "list", "poll", "send", "stop", "wait"] as const;

export const ActionSchema = StringEnum(ActionValues, {
	description: "Thread command to run.",
});

export const SendModeSchema = StringEnum(["prompt", "steer", "follow_up"] as const, {
	description: "Delivery mode. Omit for prompt when idle, follow_up when busy.",
});

export const ListStateSchema = StringEnum(["all", "live", "closed"] as const, {
	description: "Filter listed threads by runtime state.",
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

export const StrictPiThreadParamsSchema = Type.Union(
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

export const PiThreadParamsSchema = Type.Object(
	{
		action: ActionSchema,
		prompt: Type.Optional(
			Type.String({
				minLength: 1,
				description: "For start: initial child task prompt.",
			}),
		),
		name: Type.Optional(
			Type.String({ minLength: 1, description: "For start: display name for the child session." }),
		),
		taskName: Type.Optional(
			Type.String({
				pattern: "^[a-z0-9][a-z0-9_]{0,63}$",
				description: "For start: stable lower_snake_case path segment.",
			}),
		),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description: "For start: extra Pi CLI args. RPC mode is enforced.",
			}),
		),
		cwd: Type.Optional(
			Type.String({ minLength: 1, description: "For start: working directory for the child." }),
		),
		state: Type.Optional(ListStateSchema),
		parent: Type.Optional(
			Type.String({
				minLength: 1,
				description: "For list: only direct children of this path/thread.",
			}),
		),
		ancestor: Type.Optional(
			Type.String({ minLength: 1, description: "For list: only descendants of this path/thread." }),
		),
		id: Type.Optional(
			Type.String({ minLength: 1, description: `For poll/send/stop/wait: ${TargetDescription}` }),
		),
		message: Type.Optional(
			Type.String({ minLength: 1, description: "For send: message for the child." }),
		),
		mode: Type.Optional(SendModeSchema),
		force: Type.Optional(
			Type.Boolean({ description: "For stop: use SIGKILL instead of graceful stop." }),
		),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 600_000,
				description: "For wait: max wait ms. Default 30000.",
			}),
		),
	},
	{
		...Strict,
		description:
			"Manage child Pi sessions. Action-specific fields: start needs prompt; poll/send/stop/wait need id; send needs message; list may use state plus parent or ancestor, not both.",
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
export type PiThreadParams = Static<typeof StrictPiThreadParamsSchema>;
type Action = Static<typeof ActionSchema>;

export function assertPiThreadParams(value: unknown): asserts value is PiThreadParams {
	if (Value.Check(StrictPiThreadParamsSchema, value)) return;
	if (!isRecord(value)) throw new Error("Invalid thread parameters: expected object");

	const action = value["action"];
	if (!isAction(action)) {
		throw new Error(
			"Invalid thread parameters: action must be start, list, poll, send, stop, or wait",
		);
	}

	const allowed = allowedFieldsForAction(action);
	const unexpected = Object.keys(value).filter((field) => !allowed.has(field));
	if (unexpected.length > 0) {
		throw new Error(
			`Invalid thread parameters for ${action}: unexpected field${unexpected.length === 1 ? "" : "s"} ${unexpected.join(", ")}`,
		);
	}

	const missing = requiredFieldsForAction(action).filter((field) => !(field in value));
	if (missing.length > 0) {
		throw new Error(
			`Invalid thread parameters for ${action}: missing required field${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
		);
	}

	if (action === "list" && "parent" in value && "ancestor" in value) {
		throw new Error(
			"Invalid thread parameters for list: parent and ancestor are mutually exclusive",
		);
	}

	const errors = [...Value.Errors(strictSchemaForAction(action), value)];
	const summary = errors
		.slice(0, 5)
		.map((error) => error.message)
		.join("; ");
	throw new Error(`Invalid thread parameters${summary ? `: ${summary}` : ""}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is Action {
	return typeof value === "string" && ActionValues.includes(value as Action);
}

function allowedFieldsForAction(action: Action): ReadonlySet<string> {
	switch (action) {
		case "start":
			return new Set(["action", "prompt", "name", "taskName", "args", "cwd"]);
		case "list":
			return new Set(["action", "state", "parent", "ancestor"]);
		case "poll":
			return new Set(["action", "id"]);
		case "send":
			return new Set(["action", "id", "message", "mode"]);
		case "stop":
			return new Set(["action", "id", "force"]);
		case "wait":
			return new Set(["action", "id", "timeoutMs"]);
	}
}

function requiredFieldsForAction(action: Action): readonly string[] {
	switch (action) {
		case "start":
			return ["prompt"];
		case "send":
			return ["id", "message"];
		case "poll":
		case "stop":
		case "wait":
			return ["id"];
		case "list":
			return [];
	}
}

function strictSchemaForAction(action: Action) {
	switch (action) {
		case "start":
			return StartCommandSchema;
		case "list":
			return ListCommandSchema;
		case "poll":
			return PollCommandSchema;
		case "send":
			return SendCommandSchema;
		case "stop":
			return StopCommandSchema;
		case "wait":
			return WaitCommandSchema;
	}
}
