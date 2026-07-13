# `thread` tool contract

`pi-dispatch` registers one model-facing Pi tool named `thread` with the neutral
description `Start and manage background Pi child sessions.` It does not add
built-in roles, profiles, workflow presets, or proactive delegation instructions.
Workflows are layered by user prompts, skills, prompt templates, or other
extensions.

This contract describes the current public behavior of the tool and its
structured results.

## Tool surface

All calls use one JSON object with an `action` field. Extra fields are rejected
unless they belong to that action.

| Action    | Required fields | Optional fields                                         | Purpose                                                                |
| --------- | --------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `start`   | `prompt`        | `name`, `taskName`, `args`, `cwd`                       | Start a child Pi session and send the prompt verbatim.                 |
| `list`    | none            | `state`, `visibility`, `parent`, `ancestor`             | List managed threads. `parent` and `ancestor` are mutually exclusive.  |
| `poll`    | `id`            | `detail`                                                | Refresh and inspect one thread.                                        |
| `send`    | `id`, `message` | `mode`                                                  | Send another message to a live thread.                                 |
| `stop`    | `id`            | `force`                                                 | Stop a live thread, or return the closed snapshot if already closed.   |
| `wait`    | `id`            | `detail`, `timeoutMs`                                   | Wait for a thread to become idle/closed, or for timeout.               |
| `resume`  | `id`            | none                                                    | Reopen a saved managed child session as a live thread.                 |
| `fork`    | none            | `id`, `entryId`, `position`, `name`, `taskName`, `args` | Fork the current session or a managed child into a new managed thread. |
| `archive` | `id`            | `archived`                                              | Hide or unhide a closed/stale thread without deleting session history. |

## Common references

Fields named `id` accept any known thread reference:

- thread id, for example `thread_012345abcdef`;
- canonical path, for example `/root/review_docs`;
- relative path from the current thread, for example `review_docs` or
  `parent/child`;
- unambiguous task name or path basename.

`list.parent` and `list.ancestor` also accept `.` or `self` for the current
thread path. Syntactically valid paths can be used as list filters even if no
thread exists at exactly that path.

Thread paths are rooted at `/root`. `taskName` values must match
`^[a-z0-9][a-z0-9_]{0,63}$`.

## Action details

### `start`

```json
{
  "action": "start",
  "name": "API survey",
  "taskName": "api_survey",
  "prompt": "Inspect the public API and report mismatches. Do not edit files.",
  "cwd": ".",
  "args": ["--model", "anthropic/claude-sonnet-4-5"]
}
```

- `prompt` is sent to the child verbatim. Parent conversation context is not
  copied automatically; include all required context in the prompt.
- `name` is display-only. When omitted, it is generated from the first useful
  prompt line, the task name, or a short id.
- `taskName` is the stable final path segment. When omitted, it is generated
  from `name`, then `prompt`, then a short id, with a unique numeric suffix when
  needed.
- `cwd` resolves relative to the parent session cwd and must be an existing
  directory. Omit it to use the parent cwd.
- `args` are optional, allowlisted Pi CLI narrowing flags. Children always run
  in RPC mode, and session/approval flags are managed by `pi-dispatch`.

Allowed `args` are:

- value flags: `--provider`, `--model`, `--models`, `--thinking`,
  `--exclude-tools`/`-xt`;
- boolean flags: `--no-tools`/`-nt`, `--no-builtin-tools`/`-nbt`, `--offline`,
  `--no-extensions`/`-ne`, `--no-skills`/`-ns`,
  `--no-prompt-templates`/`-np`, `--no-themes`, `--no-context-files`/`-nc`.

Inline `--flag=value` forms, package subcommands, positional prompts, raw
`--session`, raw `--fork`, one-shot modes, and approval flags are rejected. If
the parent was started with an inherited `--models` scope, child model/provider
or thinking overrides are rejected so the child cannot loosen that scope.

### `list`

```json
{ "action": "list", "state": "live", "visibility": "active" }
```

- `state`: `all` (default), `live`, or `closed`.
- `visibility`: `active` (default), `archived`, or `all`.
- `parent`: only direct children of a path/reference.
- `ancestor`: all descendants below a path/reference.

Results are sorted by canonical path.

### `poll`

```json
{ "action": "poll", "id": "/root/api_survey", "detail": "summary" }
```

Refreshes live child state when possible and returns a runtime snapshot.

### `send`

```json
{
  "action": "send",
  "id": "api_survey",
  "message": "Also compare the examples against the current schema.",
  "mode": "follow_up"
}
```

`mode` is one of:

- `prompt`;
- `steer`;
- `follow_up`.

When `mode` is omitted, the default is `prompt` for an idle thread and
`follow_up` for a busy thread.

### `stop`

```json
{ "action": "stop", "id": "/root/api_survey", "force": false }
```

Graceful stop sends an abort request, then signals the child process tree if it
does not exit. On POSIX, children are launched in their own process group so
`SIGTERM`/`SIGKILL` can target descendants too; on Windows, force cleanup uses
`taskkill /T /F` before falling back to the direct child process. Stopping an
already closed thread is a no-op that returns its snapshot.

### `wait`

```json
{ "action": "wait", "id": "/root/api_survey", "timeoutMs": 30000 }
```

`timeoutMs` must be an integer from `0` to `600000`; the default is `30000`.
`wait` returns when the thread is closed, or when a live thread refreshes as idle
with no pending messages. It returns `timedOut: true` if the deadline expires.

### `resume`

```json
{ "action": "resume", "id": "/root/api_survey" }
```

`resume` requires a known saved Pi session file. It preserves the managed thread
path, display name, cwd, args, and parent linkage, and it does not send a hidden
prompt.

### `fork`

```json
{
  "action": "fork",
  "id": "/root/api_survey",
  "entryId": "abc12345",
  "position": "at",
  "name": "API survey branch",
  "taskName": "api_survey_branch"
}
```

- Omit `id` to fork the current parent session.
- Include `id` to fork a managed child session.
- Omit `entryId` to fork from the source session leaf.
- `position` is `at` (default) or `before`. `before` is valid only for a user
  message entry.
- The fork starts as a managed live thread without an implicit kickoff prompt;
  use `send` if the fork should continue with a new instruction.

### `archive`

```json
{ "action": "archive", "id": "/root/api_survey" }
```

Archive is a `pi-dispatch` visibility state. It never deletes the underlying Pi
session file. Live threads cannot be archived; stop or wait for closure first.
Use `{ "archived": false }` to unarchive.

## Detail levels

`poll` and `wait` accept `detail`:

| Detail    | Result summary                         | Events              | Output fields                                                             |
| --------- | -------------------------------------- | ------------------- | ------------------------------------------------------------------------- |
| `summary` | Compact result up to about 700 chars   | last 5 events       | no output/stderr tails                                                    |
| `tail`    | Compact result up to about 1200 chars  | last 12 events      | assistant and stderr tails up to about 4000 chars                         |
| `full`    | Full compact retained assistant result | all retained events | bounded retained `lastAssistantText`, live `lastPartialText`, full stderr |

`full` is still the retained latest assistant output, not a complete transcript
dump; very large assistant outputs are capped in memory with an explicit
truncation marker.

## Structured results

Every tool result includes concise text in `content` and machine-readable
`details`.

Single-thread actions (`start`, `poll`, `send`, `stop`, `wait`, `resume`,
`fork`, and `archive`) include:

```ts
{
  kind: string;
  snapshot: ThreadRuntimeSnapshot;
  thread: ThreadRuntimeSnapshot; // alias of snapshot
  running: boolean;
  detail: "summary" | "tail" | "full";
  nextSuggestedActions: string[];
}
```

Action-specific detail fields are:

- `start`: `promptAccepted`, `note`;
- `send`: `mode`, `accepted`, `error` (`accepted` is `true`, `false`, or `null` when delivery acceptance is unknown after an RPC timeout; poll/wait before retrying);
- `wait`: `timedOut`, `waitedMs`;
- `stop`: `alreadyClosed`;
- `resume`: `alreadyLive`;
- `fork`: `sourceSessionFile`, `sourceEntryId`;
- `archive`: `archived`.

`list` returns:

```ts
{
  kind: "listed";
  threads: ThreadRuntimeSnapshot[];
  snapshots: ThreadRuntimeSnapshot[]; // alias of threads
  count: number;
  liveCount: number;
  closedCount: number;
  detail: "summary";
}
```

### `ThreadRuntimeSnapshot`

Runtime snapshots are plain JSON objects shaped for orchestration:

```ts
type ThreadRuntimeSnapshot = {
  id: string;
  path: string;
  name: string;
  taskName: string;
  status: "live" | "closed";
  phase: "starting" | "busy" | "idle" | "stopping" | "failed" | "stale";
  running: boolean;
  parentPath: string;
  parentThreadId: string | null;
  depth: number;
  archived: boolean;
  resumable: boolean;
  stale: boolean;
  cwd: string;
  args: string[];
  createdAt: string;
  lastEventAt: string;
  session: ThreadSession;
  detail: "summary" | "tail" | "full";
  result: ThreadResultSummary;
  resultSummary?: string;
  recentEvents: ThreadEvent[];
  nextSuggestedActions: string[];
  pid?: number;
  exit?: ThreadExit;
  outputTail?: string;
  outputCharCount?: number;
  outputTruncated?: boolean;
  stderrTail?: string;
  stderrTruncated?: boolean;
  lastAssistantText?: string;
  lastPartialText?: string;
};
```

For live threads, `phase` is one of `starting`, `busy`, `idle`, or `stopping`.
For closed threads, `phase` is `stale`, `failed`, or `idle` depending on the
exit state.

### Events

Recent events use compact lifecycle names:

- `thread_started`, `thread_resumed`, `thread_forked`, `thread_archived`;
- `thread_stopping`, `thread_closed`, `thread_error`;
- `turn_started`, `turn_completed`;
- `tool_started`, `tool_completed`;
- `assistant_message`;
- `ui_request`.

Child dialog UI requests (`select`, `confirm`, `input`, and `editor`) are
auto-cancelled in headless threads and recorded as `ui_request` events.

## Limits and durability

Defaults are controlled by environment variables:

| Variable                      | Default | Meaning                                                   |
| ----------------------------- | ------- | --------------------------------------------------------- |
| `PI_DISPATCH_MAX_DEPTH`       | `2`     | Maximum recursion depth.                                  |
| `PI_DISPATCH_MAX_THREADS`     | `8`     | Maximum live threads per parent manager.                  |
| `PI_DISPATCH_IDLE_CLEANUP_MS` | `0`     | Stop idle live children after this many ms; `0` disables. |
| `PI_DISPATCH_LIVE_TIMEOUT_MS` | `0`     | Stop live children after this lifetime; `0` disables.     |

Managed thread metadata is persisted as Pi custom session entries. On session
reload, saved managed threads are restored when possible. A previously live
thread restored without a live process connection becomes closed with a `stale`
exit.

When the parent Pi session exits normally, live children are stopped. If a child
`cwd` is outside the trusted parent project, the child is launched with
`--no-approve` even when the parent is approved.

## `/threads` command boundary

`/threads` is an observability browser. It supports browsing, filtering,
refresh/poll, navigation, and emergency stop. It intentionally does not provide
manual lifecycle subcommands such as `/threads start` or `/threads send`; those
remain tool-level primitives.
