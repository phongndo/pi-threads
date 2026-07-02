export const PI_THREAD_DESCRIPTION =
	"Manage child Pi sessions for independent investigation, delegation, review, or parallel work. Actions: start, list, poll, wait, send, stop.";

export const PI_THREAD_PROMPT_SNIPPET =
	"Manage child Pi sessions for independent side-work: start/list/poll/wait/send/stop.";

export const PI_THREAD_PROMPT_GUIDELINES = [
	"Use the thread tool proactively only when independent side-work materially helps; do trivial or urgent blocking work locally.",
	"Start children with concrete scope, expected output, and stable lower_snake_case taskName; parallelize only genuinely independent work.",
	"Use forkTurns sparingly; prefer explicit prompt context, none, or a small recent-turn count over all.",
	"After spawning, keep doing useful local work; wait only when blocked, otherwise poll later.",
	"Send follow-ups to clarify or redirect, and stop stale children.",
] as const;
