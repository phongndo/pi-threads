# pi-threads

Let your Pi agent create **dynamic workflows on its own** — forking, delegating, reviewing, or parallelizing work as it sees fit, with no hard-coded workflow graph.

Pi threads are normal Pi sessions that run in the background. Your Pi agent can start them with a prompt, check on their progress, send follow-up messages, and stop them when done — all from within a single conversation. A child thread has its own working directory, its own context window, and its own tool access, so parallel investigations stay isolated and don't bloat the parent session.

There are no baked-in roles (no "reviewer", no "planner", no "worker"). Pi decides what to fork and why. Recursion is supported: child sessions can spawn their own children, guarded by depth and concurrency limits.

## What Pi can do with threads

- **Parallelize** — investigate multiple files, codebases, or approaches at once.
- **Delegate** — hand off a large, self-contained task so the parent stays focused.
- **Review** — have one thread produce work and another critique it.
- **Explore** — spin up a throwaway thread to test an idea without polluting the parent session.
- **Compose** — chain threads together: one gathers context, another acts on it.

## Commands

Pi calls the `pi_thread` tool with one action:

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

`start` accepts `forkTurns` for lightweight context forking into the child
prompt: `none` (default), `all`, or a positive number of recent user turns.
This keeps the implementation process-isolated while giving Pi an explicit,
bounded way to hand context to subthreads when useful.

## Installation

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
