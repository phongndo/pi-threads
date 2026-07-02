# pi-threads

`pi-threads` gives Pi one small recursive primitive: start another Pi session, talk to it, inspect it, and stop it. It lets your Pi agent create **dynamic workflows on its own** — forking, delegating, reviewing, or parallelizing work as it sees fit, without any hard-coded workflow graph.

It intentionally does **not** encode roles, workflows, reviewers, planners, or schedulers. Child sessions are normal Pi RPC sessions in the selected working directory, with normal Pi startup behavior. If this package is installed normally, child sessions can load it normally too; recursion is guarded by depth limits.

## Tool

The extension registers one tool, `pi_thread`, with a strict tagged-union input:

```ts
type PiThreadCommand =
  | { action: "start"; prompt: string; name?: string; args?: string[]; cwd?: string }
  | { action: "list" }
  | { action: "poll"; id: string }
  | { action: "send"; id: string; message: string; mode?: "prompt" | "steer" | "follow_up" }
  | { action: "stop"; id: string; force?: boolean };
```

Invalid combinations like `{ action: "poll", prompt: "..." }` are rejected by schema and by TypeScript.

## Development

```bash
nix develop
pnpm install
pnpm check
pnpm dev:pi
```

Install locally once it is ready:

```bash
pi install /Users/dp/code/projects/pi-threads
```

Useful commands:

```bash
pnpm oxformat       # format with oxfmt
pnpm lint           # lint with oxlint
pnpm typecheck      # strict TypeScript
pnpm test           # unit tests
pnpm lsp:ts         # TypeScript LSP
pnpm lsp:oxlint     # Oxlint LSP
pnpm lsp:oxformat   # oxfmt LSP
```

## Runtime safety

- Child sessions run in RPC mode and are killed when the parent Pi session shuts down.
- Interactive UI requests from child sessions are auto-cancelled and recorded, because the child is headless.
- Recursion is limited with `PI_THREADS_DEPTH` / `PI_THREADS_MAX_DEPTH` (`2` by default).
- Extra Pi args are allowed as an escape hatch but cannot override RPC mode or use one-shot CLI modes.
