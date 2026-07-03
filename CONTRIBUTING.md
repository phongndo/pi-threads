# Contributing to pi-threads

Thanks for helping improve `pi-threads`. This project is a Pi extension, so the
bar for changes is that they are safe for interactive agent sessions, easy to
review, and covered by focused tests.

## Development setup

Requirements:

- Node.js `>=22.19.0`
- pnpm `11.9.0`
- Optional: Nix, if you want the pinned development shell

```bash
nix develop      # optional
pnpm install
pnpm check
```

Useful commands:

```bash
pnpm oxformat        # format the repo
pnpm lint            # run oxlint
pnpm typecheck       # run tsc --noEmit
pnpm test            # run vitest once
pnpm test:watch      # run vitest in watch mode
pnpm dev:pi          # run Pi with this extension loaded locally
pnpm licenses:list   # list dependency license metadata from pnpm
```

Install the git hooks if you want local pre-commit formatting and linting:

```bash
pnpm hooks:install
```

## Pull request checklist

Before opening a PR, please make sure:

- `pnpm check` passes.
- New behavior has tests in `test/`.
- User-facing behavior is documented in `README.md` when relevant.
- Tool schemas and prompt guidance stay aligned with runtime behavior.
- Changes that affect safety, process management, or child-session arguments are
  called out clearly in the PR description.

## Coding guidelines

- Keep TypeScript strict and avoid broad `any` types.
- Prefer small, explicit helpers over implicit side effects.
- Preserve the safety model for child sessions: inherited restrictions must not
  be loosened by tool input.
- Treat the thread tool as an agent-facing API. Error messages and result
  summaries should be actionable for both humans and agents.
- Do not commit generated dependency folders, coverage, logs, or build output.

## Reporting issues

For bugs, include:

- Pi version and `pi-threads` version.
- Operating system and shell.
- The exact command or tool call that failed.
- Expected behavior, actual behavior, and relevant logs or thread output.

Please do not report security vulnerabilities in public issues. See
`SECURITY.md` instead.

## License

By contributing to this repository, you agree that your contributions are
licensed under the MIT License in `LICENSE`.
