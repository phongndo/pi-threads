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

This extension teaches Pi through the tool metadata in `src/prompt.ts`, not by
expecting the user to mention threads. The `thread` tool contributes a prompt
snippet plus usage guidelines that tell Pi to use threads proactively when they
materially improve the workflow: sidecar research, parallel independent tasks,
bounded implementation slices, or second-pass review.

The behavior is intentionally emergent rather than workflow-specific. There is
no fixed planner/reviewer/worker graph; Pi receives enough guidance to decide
when to spawn, what to ask, when to wait, and when to keep work local.

## What Pi can do with threads

- **Parallelize** — investigate multiple files, codebases, or approaches at once.
- **Delegate** — hand off a large, self-contained task so the parent stays focused.
- **Review** — have one thread produce work and another critique it.
- **Explore** — spin up a throwaway thread to test an idea without polluting the parent session.
- **Compose** — chain threads together: one gathers context, another acts on it.

## Commands

Pi calls the `thread` tool with one action:

| Action  | What it does                                                      |
| ------- | ----------------------------------------------------------------- |
| `start` | Spawn a child Pi session with a prompt. Returns a thread id.      |
| `poll`  | Check a thread's status, see its latest output and recent events. |
| `send`  | Send a follow-up message to a running thread.                     |
| `wait`  | Wait until a child session is idle/closed or a timeout expires.   |
| `list`  | List all threads managed by this parent session.                  |
| `stop`  | Stop a thread gracefully (or forcefully).                         |

Example tool calls:

```json
{
  "action": "start",
  "prompt": "Review the API docs for stale examples and report exact fixes.",
  "taskName": "review_docs"
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
{ "action": "poll", "id": "/root/review_docs" }
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

Threads also get a stable canonical path like `/root/review_tests`. Pass
`taskName` on `start` to choose the final path segment, then refer to the thread
later by id, full path, or unambiguous task name.

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

Use `/threads` in Pi's TUI to open an interactive thread browser for the current
session. It defaults to all known threads so completed work remains visible.
Use `/threads exit` as the explicit thread-session exit command; `/exit` remains
the convenient shortcut that returns to the parent when a parent thread session
is recorded.
Other arguments show usage instead of silently falling back to the browser. The
TUI opens with no arguments.

The browser follows Pi's native tree-like UI style with state badges, friendly
thread titles, search, and keyboard controls. Use `↑`/`↓` to navigate, type to
search, `tab` to cycle filters (`all` → `live` → `closed`), `enter` to enter a
closed/stopped thread's Pi session, `ctrl+p` to poll/refresh that row, `ctrl+r`
to refresh the list, `ctrl+x` to stop it, and `esc` to clear search or close.
The control legend is shown below the browser title.

When you enter a closed/stopped thread from `/threads`, pi switches to that child
session and records the parent session. Live threads must be stopped or closed
before they can be opened. Use `/exit` from inside the child session to switch
back to the parent. Outside a recorded thread session, `/exit` behaves like a
normal Pi shutdown request; `/threads exit` is the thread-specific form and warns
when no parent session is recorded. Entering is disabled when Pi was started with
`--no-session`, because there is no saved parent session to return to.

Friendly titles (generated session name, `name`, then `taskName` or short id)
are for display in the TUI. Tool call headers and automation use stable
references: the `thread_...` id, the canonical path such as
`/root/review_tests`, or an unambiguous task name.

`start` sends the supplied prompt to the child session verbatim. Threads do not
implicitly copy parent conversation context; include any context the child needs
directly in the prompt.

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
