# Compatibility

This project is a pre-1.0 Pi extension. Keep the compatibility notes here in
sync with `package.json`, `README.md`, `CONTRIBUTING.md`, and CI before cutting a
release.

## Supported toolchain

| Component       | Supported range / version | CI and release baseline                    | Notes                                                                                                                                         |
| --------------- | ------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js         | `>=22.19.0`               | `22.19`                                    | Matches `engines.node` and the GitHub Actions `NODE_VERSION`.                                                                                 |
| pnpm            | `11.9.0`                  | `11.9.0`                                   | Matches `packageManager` and the GitHub Actions `PNPM_VERSION`.                                                                               |
| Pi CLI/packages | `>=0.80.3 <1.0.0`         | `0.80.3` line                              | Validated against the `@earendil-works/pi-*` dev dependencies used by this repository.                                                        |
| OS              | Linux, macOS, Windows     | Ubuntu latest + Windows latest unit checks | Linux is the primary release baseline; Windows runs typecheck/tests in CI; macOS is expected to work where the same Node and Pi versions run. |

## Pi package policy

`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, and `typebox` are wildcard peer dependencies on
purpose. Pi provides these packages at runtime, and this extension should not
force duplicate Pi runtime copies into an installed Pi environment.

Development dependencies pin the compatibility baseline used for local checks
and CI. When bumping the Pi baseline:

1. Update the Pi dev dependencies and lockfile.
2. Update the requirements in `README.md`, `CONTRIBUTING.md`, and this file.
3. Run `pnpm check` and the e2e smoke outline in
   [`release-checklist.md`](release-checklist.md).
4. Call out the new minimum Pi version in the changelog and release notes.

## Change policy

- Node lower-bound changes must update `engines.node`, CI `NODE_VERSION`, docs,
  and the release checklist.
- pnpm changes must update `packageManager`, CI `PNPM_VERSION`, the lockfile, and
  docs.
- Pi API compatibility changes should remain isolated from source refactors where
  possible and should include an e2e smoke test against the candidate package.
- Security fixes are supported for the latest published npm version and the
  current `main` branch, matching `SECURITY.md`.

## Quick validation commands

```bash
node --version
pnpm --version
pi --version
pnpm install --frozen-lockfile
pnpm check
pnpm pack --dry-run
```
