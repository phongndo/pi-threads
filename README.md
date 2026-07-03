# pi-threads

Let your Pi agent create **dynamic workflows on its own** — forking, delegating, reviewing, or parallelizing work as it sees fit, with no hard-coded workflow graph.

Pi threads are normal Pi sessions that run in the background. Your Pi agent can start them with a prompt, check on their progress, send follow-up messages, and stop them when done — all from within a single conversation. A child thread has its own working directory, its own context window, and its own tool access, so parallel investigations stay isolated and don't bloat the parent session.

There are no baked-in roles (no "reviewer", no "planner", no "worker"). Pi decides what to fork and why. Recursion is supported: child sessions can spawn their own children, guarded by depth and concurrency limits.

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

Threads also get a stable canonical path like `/root/review_tests`. Pass
`taskName` on `start` to choose the final path segment, then refer to the thread
later by id, full path, or unambiguous task name.

## Observability

Use `/threads` in Pi's TUI to open an interactive thread browser for the current
session. It defaults to all known threads so completed work remains visible;
pass `/threads live`, `/threads all`, or `/threads closed` to filter the list.
The TUI still opens when the selected filter is empty.

The browser follows Pi's native tree-like UI style with state badges, friendly
thread titles, search, and keyboard controls. Use `↑`/`↓` to navigate, type to
search, `tab` to cycle filters (`all` → `live` → `closed`), `enter` to enter a
closed/stopped thread's Pi session, `ctrl+p` to poll/refresh that row, `ctrl+r`
to refresh the list, `ctrl+x` to stop it, and `esc` to clear search or close.
The control legend is shown below the browser title.

When you enter a closed/stopped thread from `/threads`, pi switches to that child
session and records the parent session. Live threads must be stopped or closed
before they can be opened. Use `/exit` from inside the child session to switch
back to the parent. Entering is disabled when Pi was started with `--no-session`,
because there is no saved parent session to return to. `/thread exit` is kept as
an explicit alias.

Friendly titles (generated session name, `name`, then `taskName` or short id)
are for display in the TUI and tool call labels. For automation and follow-up
tool calls, prefer stable references: the `thread_...` id, the canonical path
such as `/root/review_tests`, or an unambiguous task name.

`start` accepts `forkTurns` for lightweight context forking into the child
prompt: `none` (default), `all`, or a positive number of recent user turns.
This keeps the implementation process-isolated while giving Pi an explicit,
bounded way to hand context to subthreads when useful.

## Installation

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

| Variable                            | Default | Purpose                                                |
| ----------------------------------- | ------- | ------------------------------------------------------ |
| `PI_THREADS_MAX_DEPTH`              | `2`     | How deep threads can spawn threads.                    |
| `PI_THREADS_MAX_THREADS`            | `8`     | Max concurrent live threads per parent.                |
| `PI_THREADS_FORK_CONTEXT_MAX_CHARS` | `24000` | Max parent-context characters included by `forkTurns`. |

## Safety

- Threads are killed when the parent Pi session exits.
- Interactive prompts (dialogs, confirmations) in headless threads are auto-cancelled.
- One-shot CLI modes (`--print`, `--export`, etc.) are blocked in child threads.
- Recursion depth and live-thread count are capped.

## Development

```bash
nix develop
pnpm install
pnpm check          # format + lint + typecheck + test
pnpm dev:pi         # run Pi with the extension loaded locally
```
