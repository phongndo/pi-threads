# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No changes yet.

## [0.4.0] - 2026-07-09

### Added

- Added a typed awaiting-send state machine and focused thread lifecycle modules
  for process management, state transitions, and persistence.
- Added a Pi session adapter that centralizes registry materialization,
  cross-session appends, safe session reads, and persistence-failure reporting.
- Added runtime and regression coverage for Pi RPC stdin shutdown, concurrent
  session writers, awaiting-send transitions, persistence fallbacks, timeout
  handling, hydration, and lifecycle edge cases.
- Added Windows typecheck/test coverage to CI.

### Changed

- Refactored `ThreadManager` into smaller lifecycle, state, process, and
  persistence helpers while preserving the public tool surface.
- Reduced registry persistence to meaningful lifecycle transitions instead of
  streaming text deltas, and added cheap hydration caching for unchanged
  session state.
- `send` results now report `accepted: null` / `Accepted: unknown` when an RPC
  acceptance check times out after the request was written; callers should poll
  or wait before retrying because the child may still process the message.
- `detail: full` now returns bounded retained assistant output with an explicit
  truncation marker for very large messages instead of keeping unbounded text in
  memory.
- `/threads` live-thread stop now requires a second `ctrl+x` confirmation.

### Fixed

- Fixed registry restore after cross-session or concurrent session writes by
  hydrating registry entries from the full session file instead of only the
  current leaf branch.
- Fixed first-sync hydration after changing thread scope so the new scope is
  bound before restore.
- Fixed timed-out sends so written-but-unconfirmed requests remain protected
  from idle cleanup until a later poll or wait confirms child state.
- Fixed persistence errors being silently swallowed by surfacing a throttled
  degraded-persistence warning/event.
- Fixed persistence-error bookkeeping when closed threads are dropped during
  scope/session cleanup.
- Fixed RPC timeout labels and messaging for initial prompts and send modes.

## [0.3.1] - 2026-07-07

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

### Fixed

- Fixed a `wait` timeout race where a child closing exactly at the deadline
  could be reported with stale timing/state.

## [0.3.0] - 2026-07-05

### Added

- Repository community health documentation: contributing guide, security policy,
  code of conduct, issue templates, and pull request template.
- README links for project quality, support, security, and license information.
- Optional `PI_DISPATCH_IDLE_CLEANUP_MS` and `PI_DISPATCH_LIVE_TIMEOUT_MS` safety
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
