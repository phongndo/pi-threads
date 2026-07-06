# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tool contract and workflow-authoring documentation, including example
  user-authored workflow patterns.
- Release compatibility and npm provenance checklist documentation.
- Golden contract tests for runtime snapshots and tool result details.
- Pure registry helper tests covering truncation, durable restore filtering, and
  corrupt-entry rejection.

### Changed

- Split child CLI argument policy, task naming, and registry helpers out of
  `ThreadManager` into focused modules.
- `/threads` browser filtering and counts now use a cached single-pass view.
- POSIX child Pi processes now launch in their own process group so stop/force
  cleanup can target descendant processes; Windows force-stop uses
  `taskkill /T /F` best-effort process-tree cleanup.

## [0.3.0] - 2026-07-05

### Added

- Repository community health documentation: contributing guide, security policy,
  code of conduct, issue templates, and pull request template.
- README links for project quality, support, security, and license information.
- Optional `PI_THREADS_IDLE_CLEANUP_MS` and `PI_THREADS_LIVE_TIMEOUT_MS` safety
  controls for stale live children.

### Changed

- CI now uses least-privilege read permissions and performs an npm pack smoke
  test.
- Package metadata now follows Pi package guidance by keeping Pi-bundled runtime
  packages as wildcard peer dependencies.
- Package description now reflects the broader background-thread lifecycle.
- `/threads` usage/docs now clarify that the command is observability-first, not
  a manual thread lifecycle control surface.
- Public thread snapshot typings now use shared base interfaces to reduce
  duplicated domain shape definitions.
- Live-child shutdown now uses a shared bounded stop path with SIGTERM then
  SIGKILL fallback and a persisted final stopped snapshot.
