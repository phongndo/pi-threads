# pi-threads

[![CI](https://github.com/phongndo/pi-threads/actions/workflows/ci.yml/badge.svg)](https://github.com/phongndo/pi-threads/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40phongndo%2Fpi-threads)](https://www.npmjs.com/package/@phongndo/pi-threads)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Let your Pi agent create **dynamic workflows on its own** — delegating, reviewing, or parallelizing work as it sees fit, with no hard-coded workflow graph.

> Status: usable pre-1.0 Pi extension. The behavior is covered by CI and tests,
> but compatibility follows Pi's evolving extension APIs.

Pi threads are normal Pi sessions that run in the background. Your Pi agent can start them with a prompt, check on their progress, send follow-up messages, and stop them when done — all from within a single conversation. A child thread has its own working directory, its own context window, and its own tool access, so parallel investigations stay isolated and don't bloat the parent session.

There are no baked-in roles (no "reviewer", no "planner", no "worker"). Pi decides what to delegate and why. Recursion is supported: child sessions can spawn their own children, guarded by depth and concurrency limits.

## How Pi learns to use it

By default, this extension is a minimal background-session primitive. It
registers a single `thread` tool with Pi and relies on the tool registry,
description, and schema. It does not inject proactive delegation guidance into
the system prompt. Users can add their own system prompt, skills, prompt
templates, or extension policy when they want Pi to use threads more
aggressively.

There is no fixed planner/reviewer/worker graph and no built-in agent profile
system. `pi-threads` exposes thread capability; orchestration style belongs to
the user.

## What Pi can do with threads

- **Parallelize** — investigate multiple files, codebases, or approaches at once.
- **Delegate** — hand off a large, self-contained task so the parent stays focused.
- **Review** — have one thread produce work and another critique it.
- **Explore** — spin up a throwaway thread to test an idea without polluting the parent session.
- **Compose** — chain threads together: one gathers context, another acts on it.

## Commands

Pi calls a single model-facing `thread` tool with an `action` field. The
extension does not expose separate `thread_start`, `thread_poll`, or other split
tools:

| Action    | What it does                                                    |
| --------- | --------------------------------------------------------------- |
| `start`   | Spawn a child Pi session with a prompt. Returns a thread id.    |
| `poll`    | Check a thread's status, summarized output, and recent events.  |
| `send`    | Send a follow-up message to a running thread.                   |
| `wait`    | Wait until a child session is idle/closed or a timeout expires. |
| `list`    | List all threads managed by this parent session.                |
| `stop`    | Stop a thread gracefully (or forcefully).                       |
| `resume`  | Reopen a saved managed child session as a live thread.          |
| `fork`    | Fork the parent/current child session into a managed thread.    |
| `archive` | Hide completed/stale threads without deleting session history.  |

Example tool calls:

```json
{
  "action": "start",
  "name": "Review docs",
  "prompt": "Review the API docs for stale examples and report exact fixes."
}
```

```json
{
  "action": "start",
  "prompt": "Run the focused test suite and summarize failures.",
  "taskName": "test_runner",
  "cwd": "/path/to/project",
  "args": ["--model", "anthropic/claude-sonnet-4-5", "--thinking", "low"]
}
```

```json
{ "action": "poll", "id": "/root/review_docs", "detail": "summary" }
```

```json
{ "action": "poll", "id": "/root/review_docs", "detail": "full" }
```

```json
{
  "action": "send",
  "id": "review_docs",
  "message": "Also check README examples against the current schema.",
  "mode": "follow_up"
}
```

```json
{ "action": "wait", "id": "/root/test_runner", "timeoutMs": 30000 }
```

```json
{ "action": "list", "state": "live" }
```

```json
{ "action": "resume", "id": "/root/review_docs" }
```

```json
{ "action": "fork", "id": "/root/review_docs", "entryId": "abc12345" }
```

```json
{ "action": "archive", "id": "/root/review_docs" }
```

```json
{ "action": "list", "visibility": "archived" }
```

Threads also get a stable canonical path like `/root/review_tests`. Omit
`taskName` to generate a unique lower_snake_case path segment from `name` or the
prompt, or pass `taskName` on `start` to choose the final path segment yourself.
Refer to the thread later by id, full path, or unambiguous task name.

If `start.cwd` is provided, it must resolve to an existing directory. Omit it to
use the parent session's current working directory.

Tool results include concise text plus structured `details`. Single-thread
actions (`start`, `poll`, `send`, `wait`, and `stop`) include a normalized
`snapshot` with `id`, `path`, `status`, `phase`, `running`, `detail`,
`resultSummary`, recent events, and `nextSuggestedActions`; `list` returns the
same shape in `snapshots`. Recent events use compact canonical lifecycle names
such as `thread_started`, `turn_started`, `tool_started`, `tool_completed`,
`assistant_message`, `turn_completed`, and `thread_closed`.

`poll` and `wait` accept `detail: "summary" | "tail" | "full"`. The default is
`summary`, which returns a compact child-result summary and a small event tail.
`tail` adds bounded output/stderr tails. `full` is explicit opt-in and returns
the full retained last assistant output in the structured snapshot.

`start.args` is intentionally allowlisted. Children always run in RPC mode;
one-shot modes, session selection, approval flags, package subcommands, bare
positional args, and `--flag=value` forms are rejected. Safe narrowing flags such
as `--provider`, `--model`, `--models`, `--thinking`, `--exclude-tools`,
`--no-tools`, `--no-builtin-tools`, `--offline`, `--no-extensions`,
`--no-skills`, `--no-prompt-templates`, `--no-themes`, and
`--no-context-files` can be supplied when a child needs narrower behavior. If
the parent was started with an inherited `--models` scope, child
model-selection args (`--provider`, `--model`, or `--models`) are rejected so a
tool call cannot loosen that scope.

Children also inherit relevant parent Pi restrictions and resource-loading flags
that Pi parsed from the parent process, including model/provider choices, tool
restrictions, extension/skill/prompt/theme flags, and `--no-*` resource flags.
Use Pi's supported `--flag value` form for inherited value flags; inline
`--flag=value` assignments are not reinterpreted for children. This lets a
parent started with installed or explicit extensions keep the same environment in
children while preventing a tool call from loosening the parent's restrictions.

## Observability

Use `/threads` in Pi's TUI to open an interactive observability browser for the
current session. It loads all known threads, including archived entries, and
defaults to active visibility.
Other arguments show usage instead of silently falling back to the browser. The
TUI opens with no arguments and uses Pi's native editor-replacement surface, so
the parent chat remains visible while browsing.

The browser follows Pi's native tree-like UI style with state badges, friendly
thread titles, search, status/visibility filters, and a selected-thread detail
panel with result summary, session metadata, parent/child info, and recent event
timeline. Use `↑`/`↓` to navigate, `←`/`→` to jump to visible parent/child
threads, type to search, `tab` to cycle status filters, `ctrl+v` to cycle
visibility (`active` → `archived` → `all`), `ctrl+p` to poll/refresh that row,
`ctrl+r` to refresh the list, `ctrl+x` to stop it, and `esc` to clear search or
close. The control legend is shown below the browser title.

The browser intentionally does not expose start, resume, fork, archive, or send
controls. Those remain agent/tool-level orchestration primitives. User-facing
browser controls are limited to observing, navigating, polling/refreshing, and
stopping live work for safety. It intentionally does not attach to or render
child Pi sessions; use agent/tool actions such as `poll`, `wait`, and `list` for
thread output, and keep orchestration in the parent chat.

Friendly titles (generated session name, `name`, then `taskName` or short id)
are for display in the TUI. Tool call headers and automation use stable
references: the `thread_...` id, the canonical path such as
`/root/review_tests`, or an unambiguous task name.

`start` sends the supplied prompt to the child session verbatim. Threads do not
implicitly copy parent conversation context; include any context the child needs
directly in the prompt. The extension does not provide context-transfer modes;
context strategy belongs to the caller, prompt, skill, template, or another
extension.

Durability uses Pi-native session files and non-context custom session entries.
When a parent session is saved, new children are started from an explicit child
session file whose header records Pi's native `parentSession` metadata. `resume`
reopens that saved session without sending a hidden prompt. `fork` uses Pi's
session tree APIs and starts the forked session without an implicit kickoff
message; send an explicit `send` action if the fork should continue with a new
instruction. `archive` is only a pi-threads visibility state and never deletes
the underlying Pi session file.

## Installation

Requirements:

- Node.js `>=22.19.0`
- Pi packages `>=0.80.3 <1.0.0`

From npm:

```bash
pi install npm:@phongndo/pi-threads
```

To try it for one Pi run without installing:

```bash
pi -e npm:@phongndo/pi-threads
```

For a project-local/team install, run from the project root:

```bash
pi install -l npm:@phongndo/pi-threads
```

From a local checkout during development:

```bash
pi install /path/to/pi-threads
```

## Configuration

| Variable                 | Default | Purpose                                 |
| ------------------------ | ------- | --------------------------------------- |
| `PI_THREADS_MAX_DEPTH`   | `2`     | How deep threads can spawn threads.     |
| `PI_THREADS_MAX_THREADS` | `8`     | Max concurrent live threads per parent. |

## Safety

- Threads are killed when the parent Pi session exits.
- Interactive prompts (dialogs, confirmations) in headless threads are auto-cancelled.
- One-shot CLI modes (`--print`, `--export`, etc.) are blocked in child threads.
- If a child `cwd` is outside the trusted parent project, it is launched with
  `--no-approve` even when the parent cwd is approved.
- Recursive threads require the child to load this extension too. This works for
  installed extensions and explicit `-e`/`--extension` loading inherited from the
  parent; custom loading mechanisms that are not represented in Pi's CLI args may
  leave children without the `thread` tool.
- Recursion depth and live-thread count are capped.

## Development

```bash
nix develop
pnpm install
pnpm check          # format + lint + typecheck + test
pnpm dev:pi         # run Pi with the extension loaded locally
```

Quality gates are enforced by GitHub Actions on pushes and pull requests. The
local `pnpm check` command runs the same format, lint, typecheck, and test suite.

## Project health

- Contributing guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Code of conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)
- Dependency license summary: `pnpm licenses:list`

## License

This project is released under the OSI-approved MIT License. See
[`LICENSE`](LICENSE) for the full standard license text.
