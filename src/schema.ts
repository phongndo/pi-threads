import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";

const Strict = { additionalProperties: false } as const;
const ActionValues = [
	"start",
	"list",
	"poll",
	"send",
	"stop",
	"wait",
	"resume",
	"fork",
	"archive",
] as const;

export const ActionSchema = StringEnum(ActionValues, {
	description: "Thread command to run.",
});

export const SendModeSchema = StringEnum(["prompt", "steer", "follow_up"] as const, {
	description: "Delivery mode. Omit for prompt when idle, follow_up when busy.",
});

export const ListStateSchema = StringEnum(["all", "live", "closed"] as const, {
	description: "Filter listed threads by runtime state.",
});

export const ListVisibilitySchema = StringEnum(["active", "archived", "all"] as const, {
	description: "Filter listed threads by archive visibility. Defaults to active.",
});

export const DetailSchema = StringEnum(["summary", "tail", "full"] as const, {
	description: "Output/detail level. Defaults to summary; full is explicit opt-in.",
});

export const ForkPositionSchema = StringEnum(["at", "before"] as const, {
	description:
		"For fork: fork at the selected entry, or before a selected user message. Defaults to at.",
});

const TargetDescription = "Thread id, canonical path (/root/task), or unambiguous task name.";

export const StartCommandSchema = Type.Object(
	{
		action: Type.Literal("start", { description: "Start a new child Pi session." }),
		prompt: Type.String({
			minLength: 1,
			description:
				"Initial child task prompt. Sent verbatim; parent conversation context is not inherited.",
		}),
		name: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Display name for the child Pi session. Generated from prompt when omitted.",
			}),
		),
		taskName: Type.Optional(
			Type.String({
				pattern: "^[a-z0-9][a-z0-9_]{0,63}$",
				description:
					"Stable lower_snake_case path segment. Generated from name or prompt when omitted.",
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
	visibility: Type.Optional(ListVisibilitySchema),
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
		detail: Type.Optional(DetailSchema),
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
		detail: Type.Optional(DetailSchema),
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

export const ResumeCommandSchema = Type.Object(
	{
		action: Type.Literal("resume", {
			description: "Reconnect a saved managed child Pi session as a live thread.",
		}),
		id: Type.String({ minLength: 1, description: TargetDescription }),
	},
	Strict,
);

export const ForkCommandSchema = Type.Object(
	{
		action: Type.Literal("fork", {
			description:
				"Fork the current Pi session or a managed child session into a new managed live thread.",
		}),
		id: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Optional source managed thread id/path/task name. Omit to fork the current parent session.",
			}),
		),
		entryId: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Optional Pi session tree entry id to fork from. Omit to fork from the source session leaf.",
			}),
		),
		position: Type.Optional(ForkPositionSchema),
		name: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Display name for the forked child Pi session. Generated when omitted.",
			}),
		),
		taskName: Type.Optional(
			Type.String({
				pattern: "^[a-z0-9][a-z0-9_]{0,63}$",
				description:
					"Stable lower_snake_case path segment for the forked managed thread. Generated when omitted.",
			}),
		),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description: "Extra Pi CLI args for the forked child. RPC mode and session are enforced.",
			}),
		),
	},
	Strict,
);

export const ArchiveCommandSchema = Type.Object(
	{
		action: Type.Literal("archive", {
			description:
				"Archive or unarchive a completed/stale managed thread without deleting history.",
		}),
		id: Type.String({ minLength: 1, description: TargetDescription }),
		archived: Type.Optional(
			Type.Boolean({ description: "Set false to unarchive. Defaults to true." }),
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
		ResumeCommandSchema,
		ForkCommandSchema,
		ArchiveCommandSchema,
	],
	{
		description: "Strict action union: start, list, poll, send, wait, stop, resume, fork, archive.",
	},
);

export const PiThreadParamsSchema = Type.Object(
	{
		action: ActionSchema,
		prompt: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"For start: initial child task prompt. Sent verbatim; parent conversation context is not inherited.",
			}),
		),
		name: Type.Optional(
			Type.String({
				minLength: 1,
				description: "For start/fork: display name for the child session. Generated when omitted.",
			}),
		),
		taskName: Type.Optional(
			Type.String({
				pattern: "^[a-z0-9][a-z0-9_]{0,63}$",
				description:
					"For start/fork: stable lower_snake_case path segment. Generated when omitted.",
			}),
		),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description: "For start/fork: extra Pi CLI args. RPC mode and session are enforced.",
			}),
		),
		cwd: Type.Optional(
			Type.String({ minLength: 1, description: "For start: working directory for the child." }),
		),
		state: Type.Optional(ListStateSchema),
		visibility: Type.Optional(ListVisibilitySchema),
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
			Type.String({
				minLength: 1,
				description: `For poll/send/stop/wait/resume/archive; optional source for fork: ${TargetDescription}`,
			}),
		),
		entryId: Type.Optional(
			Type.String({
				minLength: 1,
				description: "For fork: optional Pi session tree entry id to fork from.",
			}),
		),
		position: Type.Optional(ForkPositionSchema),
		detail: Type.Optional(
			StringEnum(["summary", "tail", "full"] as const, {
				description: "For poll/wait: output detail level. Defaults to summary.",
			}),
		),
		message: Type.Optional(
			Type.String({ minLength: 1, description: "For send: message for the child." }),
		),
		mode: Type.Optional(SendModeSchema),
		force: Type.Optional(
			Type.Boolean({ description: "For stop: use SIGKILL instead of graceful stop." }),
		),
		archived: Type.Optional(
			Type.Boolean({ description: "For archive: set false to unarchive. Defaults to true." }),
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
			"Manage child Pi sessions. Action-specific fields: start needs prompt; poll/send/stop/wait/resume/archive need id; fork may use id and entryId; poll/wait may use detail; send needs message; list may use state/visibility plus parent or ancestor, not both. Start prompts are sent verbatim without inherited parent conversation context.",
	},
);

export type SendMode = Static<typeof SendModeSchema>;
export type ListState = Static<typeof ListStateSchema>;
export type ListVisibility = Static<typeof ListVisibilitySchema>;
export type ThreadDetail = Static<typeof DetailSchema>;
export type StartCommand = Static<typeof StartCommandSchema>;
export type ListCommand = Static<typeof ListCommandSchema>;
export type PollCommand = Static<typeof PollCommandSchema>;
export type SendCommand = Static<typeof SendCommandSchema>;
export type StopCommand = Static<typeof StopCommandSchema>;
export type WaitCommand = Static<typeof WaitCommandSchema>;
export type ResumeCommand = Static<typeof ResumeCommandSchema>;
export type ForkCommand = Static<typeof ForkCommandSchema>;
export type ArchiveCommand = Static<typeof ArchiveCommandSchema>;
export type PiThreadParams = Static<typeof StrictPiThreadParamsSchema>;
type Action = Static<typeof ActionSchema>;

const ActionExamples = {
	start: `{ "action": "start", "prompt": "Inspect the failing tests." }`,
	list: `{ "action": "list", "state": "live" }`,
	poll: `{ "action": "poll", "id": "/root/inspect_tests" }`,
	send: `{ "action": "send", "id": "/root/inspect_tests", "message": "Continue", "mode": "follow_up" }`,
	stop: `{ "action": "stop", "id": "/root/inspect_tests", "force": false }`,
	wait: `{ "action": "wait", "id": "/root/inspect_tests", "timeoutMs": 30000 }`,
	resume: `{ "action": "resume", "id": "/root/inspect_tests" }`,
	fork: `{ "action": "fork", "id": "/root/inspect_tests", "entryId": "abc12345" }`,
	archive: `{ "action": "archive", "id": "/root/inspect_tests" }`,
} satisfies Record<Action, string>;

const FieldRepairHints = {
	start: {
		prompt: "prompt must be a non-empty string",
		name: "name must be a non-empty string when provided",
		taskName:
			"taskName must be lower_snake_case: start with a lowercase letter or digit, then use lowercase letters, digits, or underscores (max 64 chars)",
		args: `args must be an array of strings, e.g. "args": ["--model", "sonnet"]`,
		cwd: "cwd must be a non-empty string path to an existing directory",
	},
	list: {
		state: `state must be one of "all", "live", or "closed"`,
		visibility: `visibility must be one of "active", "archived", or "all"`,
		parent: "parent must be a non-empty thread path/reference",
		ancestor: "ancestor must be a non-empty thread path/reference",
	},
	poll: {
		id: "id must be a non-empty thread id, canonical path, or unambiguous task name",
		detail: `detail must be one of "summary", "tail", or "full"`,
	},
	send: {
		id: "id must be a non-empty thread id, canonical path, or unambiguous task name",
		message: "message must be a non-empty string",
		mode: `mode must be one of "prompt", "steer", or "follow_up"`,
	},
	stop: {
		id: "id must be a non-empty thread id, canonical path, or unambiguous task name",
		force: "force must be true or false when provided",
	},
	wait: {
		id: "id must be a non-empty thread id, canonical path, or unambiguous task name",
		detail: `detail must be one of "summary", "tail", or "full"`,
		timeoutMs: "timeoutMs must be an integer from 0 to 600000 milliseconds",
	},
	resume: {
		id: "id must be a non-empty managed thread id, canonical path, or unambiguous task name",
	},
	fork: {
		id: "id must be a non-empty managed thread id/path/task name when provided",
		entryId: "entryId must be a non-empty Pi session tree entry id when provided",
		position: `position must be one of "at" or "before"`,
		name: "name must be a non-empty string when provided",
		taskName:
			"taskName must be lower_snake_case: start with a lowercase letter or digit, then use lowercase letters, digits, or underscores (max 64 chars)",
		args: `args must be an array of strings, e.g. "args": ["--model", "sonnet"]`,
	},
	archive: {
		id: "id must be a non-empty thread id, canonical path, or unambiguous task name",
		archived: "archived must be true or false when provided",
	},
} satisfies Record<Action, Record<string, string>>;

export function assertPiThreadParams(value: unknown): asserts value is PiThreadParams {
	if (Value.Check(StrictPiThreadParamsSchema, value)) return;
	if (!isRecord(value)) {
		throw new Error(
			`Invalid thread parameters: expected an object with an action field. Repair: call the single thread tool with one valid action shape. Valid shapes: ${allActionExamples()}`,
		);
	}

	const action = value["action"];
	if (!isAction(action)) {
		throw new Error(
			`Invalid thread parameters: action must be one of ${ActionValues.join(", ")}. Repair: set "action" to a supported value and use the matching shape. Valid shapes: ${allActionExamples()}`,
		);
	}

	const allowed = allowedFieldsForAction(action);
	const unexpected = Object.keys(value).filter((field) => !allowed.has(field));
	const missing = requiredFieldsForAction(action).filter((field) => !(field in value));
	const problems: string[] = [];
	if (unexpected.length > 0) {
		problems.push(
			`unexpected field${unexpected.length === 1 ? "" : "s"} ${unexpected.join(", ")} (allowed for ${action}: ${[...allowed].join(", ")})`,
		);
	}
	if (missing.length > 0) {
		problems.push(`missing required field${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`);
	}
	if (action === "list" && "parent" in value && "ancestor" in value) {
		problems.push("parent and ancestor are mutually exclusive");
	}
	if (problems.length > 0) {
		const listConflictRepair =
			action === "list" && "parent" in value && "ancestor" in value
				? ` Choose one filter, e.g. { "action": "list", "parent": "/root" } or { "action": "list", "ancestor": "/root" }.`
				: "";
		throw new Error(
			`Invalid thread parameters for ${action}: ${problems.join("; ")}. Repair: use the ${action} shape ${ActionExamples[action]}.${listConflictRepair}`,
		);
	}

	const errors = relevantSchemaErrors(action, [
		...Value.Errors(strictSchemaForAction(action), value),
	]);
	const summary = errors
		.slice(0, 5)
		.map((error) => `${formatInstancePath(error.instancePath)} ${error.message}`)
		.join("; ");
	const hint = schemaRepairHint(action, errors);
	throw new Error(
		`Invalid thread parameters for ${action}${summary ? `: ${summary}` : ""}. Repair: ${hint} Use shape ${ActionExamples[action]}.`,
	);
}

function allActionExamples(): string {
	return ActionValues.map((action) => `${action}: ${ActionExamples[action]}`).join("; ");
}

function relevantSchemaErrors(
	action: Action,
	errors: readonly TLocalizedValidationError[],
): readonly TLocalizedValidationError[] {
	const filtered = errors.filter((error) => {
		if (error.keyword === "anyOf") return false;
		if (
			action === "list" &&
			error.instancePath === "" &&
			(error.keyword === "required" || error.keyword === "additionalProperties")
		) {
			return false;
		}
		return true;
	});
	const source = filtered.length === 0 ? errors : filtered;
	const seen = new Set<string>();
	return source.filter((error) => {
		const key = `${error.instancePath}:${error.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function schemaRepairHint(action: Action, errors: readonly TLocalizedValidationError[]): string {
	const hints: string[] = [];
	const seen = new Set<string>();
	const fieldHints = FieldRepairHints[action] as Record<string, string | undefined>;
	for (const error of errors) {
		const field = fieldNameFromInstancePath(error.instancePath);
		const hint = field === null ? null : fieldHints[field];
		if (hint === null || hint === undefined || seen.has(hint)) continue;
		seen.add(hint);
		hints.push(hint);
	}
	return hints.length === 0 ? `fix the invalid ${action} field values.` : `${hints.join("; ")}.`;
}

function formatInstancePath(instancePath: string): string {
	const field = fieldNameFromInstancePath(instancePath);
	return field === null ? "input" : field;
}

function fieldNameFromInstancePath(instancePath: string): string | null {
	if (instancePath === "") return null;
	return instancePath
		.slice(1)
		.split("/")
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
		.join(".");
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
			return new Set(["action", "state", "visibility", "parent", "ancestor"]);
		case "poll":
			return new Set(["action", "id", "detail"]);
		case "send":
			return new Set(["action", "id", "message", "mode"]);
		case "stop":
			return new Set(["action", "id", "force"]);
		case "wait":
			return new Set(["action", "id", "detail", "timeoutMs"]);
		case "resume":
			return new Set(["action", "id"]);
		case "fork":
			return new Set(["action", "id", "entryId", "position", "name", "taskName", "args"]);
		case "archive":
			return new Set(["action", "id", "archived"]);
	}
}

function requiredFieldsForAction(action: Action): readonly string[] {
	switch (action) {
		case "start":
			return ["prompt"];
		case "send":
			return ["id", "message"];
		case "resume":
		case "archive":
			return ["id"];
		case "poll":
		case "stop":
		case "wait":
			return ["id"];
		case "fork":
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
		case "resume":
			return ResumeCommandSchema;
		case "fork":
			return ForkCommandSchema;
		case "archive":
			return ArchiveCommandSchema;
	}
}
