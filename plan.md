# pi-threads audit remediation plan

This file is the shared tracker for the code-audit follow-up. The parent agent is the **orchestrator**; background Pi threads are **implementors**. Implementors should work on isolated tracks, report exact files changed and tests run, and avoid broad refactors unless their task explicitly asks for one.

## Operating model

- Orchestrator responsibilities:
  - Maintain this `plan.md` status board.
  - Start one implementor thread per independent track.
  - Resolve sequencing conflicts before handing out work.
  - Review diffs, run full checks, and integrate changes.
- Implementor responsibilities:
  - Stay within assigned scope.
  - Prefer small, test-first patches.
  - Report: summary, files changed, tests run, open questions.
  - Do not start child threads unless explicitly asked by orchestrator.
- Coordination rules:
  - Avoid concurrent edits to `src/thread-manager.ts` unless the tasks are explicitly ordered.
  - Any persistence/session-file behavior change needs regression tests before merge.
  - Keep public tool contract and repair-style error messages agent-friendly.

## Status legend

- `todo` — not started
- `assigned` — handed to an implementor thread
- `in_progress` — implementation underway
- `review` — thread reported complete; orchestrator reviewing
- `blocked` — waiting on a dependency or decision
- `done` — merged locally and verified

## Global verification gates

Run before marking a wave done:

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm oxformat:check
```

For behavior touching Pi runtime/session files, also run or document a manual/optional smoke check.

## Sequential dependency graph

1. **H5 verification** before finalizing cross-process/orphan fixes.
2. **H3/M6 timeout contract** before send-state-machine refactor.
3. **M1 scope-sync reorder** before hydration-cache work.
4. **H4 session adapter + surfaced persistence failures** before persistence policy/cache/compaction.
5. **H1 persistence policy** before H2 hydration cache tuning.
6. **H2 hydration cache** before optional registry compaction.
7. **Behavioral fixes** before `awaitingSend` rewrite.
8. **`awaitingSend` rewrite** before splitting `thread-manager.ts`.

## Parallelizable tracks

| Track                        | Can run in parallel with        | Avoid parallel with                             |
| ---------------------------- | ------------------------------- | ----------------------------------------------- |
| H5 verification/tests        | H3, M1, UX/lows                 | H1/H2 final design if H5 changes assumptions    |
| H3/M6 timeout contract       | H5, M1, schema/env lows         | M2 send-state rewrite                           |
| M1 scope-sync reorder        | H5, H3, UX/lows                 | H2 hydration cache                              |
| UX/lows                      | H5, H3, M1                      | Stop formatting waits on stop outcome semantics |
| Schema/env/lows              | Almost everything               | Broad schema refactors                          |
| H4 adapter/failure surfacing | H3/M1 after branch coordination | H1/H2 persistence internals                     |

## Implementor thread roster

| Thread                | Assignment                                                                                                               | Status | Notes                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | -----: | ------------------------------------------------------------------------------------ |
| `h5_verification`     | Verify parent SIGKILL/stdin EOF behavior and cross-process append/branch restore risk. Add tests/scripts where feasible. |   done | Confirmed side-branch loss; SIGKILL/EOF OK. See H5 findings.                         |
| `timeout_contract`    | H3/M6: timeout labels and unknown/may-deliver send/start UX.                                                             |   done | Thread `/root/timeout_contract` (`thread_37fc99f0b32a`). Touches RPC/send; avoid M2. |
| `scope_sync`          | M1: reorder scope binding before hydration and add regression.                                                           |   done | Thread `/root/scope_sync` (`thread_bb0bff3f5997`). Should be small.                  |
| `ux_lows`             | M5/L1/L2/L4/L5 cleanup batch where independent.                                                                          |   done | Thread `/root/ux_lows` (`thread_e6bb398b5d54`). Split stop semantics if needed.      |
| `persistence_adapter` | H4: adapter and persistence-failure surfacing.                                                                           |   done | Thread `/root/persistence_adapter` (`thread_373d518410d9`). H1/H2 out of scope.      |
| `persistence_policy`  | H1: meaningful-transition persistence only.                                                                              |   done | Thread `/root/persistence_policy` (`thread_3b66b13703e0`). H2 out of scope.          |
| `hydration_cache`     | H2: skip unchanged branch and cheap comparisons.                                                                         |   done | Thread `/root/hydration_cache` (`thread_db689a38f49d`).                              |
| `memory_cap`          | M4: dirty/signature cleanup verification and retained text cap.                                                          |   done | Thread `/root/memory_cap` (`thread_455fc82a207f`).                                   |
| `state_machine`       | M2: replace `awaitingSend` booleans with typed state machine.                                                            |   done | Thread `/root/state_machine` (`thread_556f9ddc9848`).                                |
| `manager_split`       | A1: split `thread-manager.ts`.                                                                                           |   done | Thread `/root/manager_split` (`thread_e4440710308f`). Conservative extraction.       |

## Task ledger

### H5 — orphan/cross-process verification

- Severity: **high for registry side-branch loss** (confirmed); orphan SIGKILL/EOF is **not a bug** (confirmed safe).
- Status: done
- Owner: `h5_verification`
- Goals:
  - Confirm Pi RPC children exit on stdin EOF when parent dies.
  - Confirm whether two `SessionManager.open(...).appendCustomEntry()` writers can create side branches invisible to `getBranch()`.
  - Add regression or smoke scripts if feasible.
- Acceptance:
  - Written finding update in this plan.
  - Test or script documents behavior.
  - If cross-process branch loss is confirmed, create follow-up fix task before H1/H2.
- Current verification notes:
  - Parent SIGKILL/stdin EOF concern is downgraded: real Pi RPC mode exits on stdin EOF in the added runtime test.
  - Cross-open `SessionManager` append risk is confirmed: dual writers can create sibling custom entries; a fresh `getBranch()` sees only the leaf side branch while `getEntries()` sees both. H1/H2 must account for this by not relying exclusively on branch restoration for scoped registry entries.

#### H5 findings (2026-07-08)

**1. Parent death / stdin EOF — safe (downgrade orphan concern)**

- Pi RPC mode (`dist/modes/rpc/rpc-mode.js`) registers `process.stdin.on("end", onInputEnd)` and calls `shutdown()`.
- Verified with real `cli.js --mode rpc`:
  - Closing stdin → process exits 0.
  - Parent SIGKILL closes the pipe → child exits (no orphan RPC process).
- Automated coverage: `test/h5-pi-runtime.test.ts` (stdin EOF + parent SIGKILL).
- **No production fix needed** for orphan Pi RPC children under normal pipe inheritance.

**2. Dual `SessionManager` writers / `getBranch()` — confirmed high risk**

- Sessions are append-only **trees** with a per-manager `leafId`. `appendCustomEntry()` parents to the in-memory leaf and advances it. `getBranch()` walks only leaf→root.
- `_buildIndex()` on open sets `leafId` to the **last entry in file order**, not a merged view of concurrent writers.
- Confirmed behaviors (real `SessionManager`, no network):
  1. **Concurrent dual-open writers** both append registry customs under the same parent → siblings. Each manager's `getBranch()` sees only its own entry. Fresh open's `getEntries()` sees both; `getBranch()` sees only the last file-order entry.
  2. **Cross-open pattern used by pi-threads** (`SessionManager.open(target.sessionFile).appendCustomEntry(...)` in `src/index.ts` while the live session manager keeps writing) → the cross-open custom entry becomes a **side branch invisible to `getBranch()`** after the live manager appends again. `getEntries()` still contains it.
- pi-threads hydration uses `getBranch()` (`safeSessionBranch` → `hydrateFromSession`), so **registry snapshots on side branches are skipped on restore**.
- Automated coverage: `test/h5-pi-runtime.test.ts`.

**Follow-up fix (completed in H2):**

- Hydrate registry from a full-file scan, not leaf branch only. Implemented via `safeSessionRegistryEntries()` preferring `getEntries()` and filtering `customType === pi-threads-registry` during durable restore.
- For cross-session appends, avoid advancing a divergent leaf when possible, or always reopen/read full file on hydrate (already need full scan).
- Optional later: serialize registry appends through the live session manager when `isCurrentSession`, and for foreign sessions use a write that does not depend on leaf (if Pi adds such an API) or accept side branches but always restore via `getEntries()`.
- Do **not** block on orphan-process work; focus on restore path + any write-path hardening.

### H3/M6 — timeout ambiguity and labels

- Status: done
- Owner: `timeout_contract`
- Files likely touched:
  - `src/rpc.ts`
  - `src/thread-manager.ts`
  - `src/format.ts`
  - `test/thread-manager.test.ts`
  - `test/json-rpc.test.ts`
- Goals:
  - RPC timeout messages include operation labels: initial prompt, send prompt, send steer, send follow-up.
  - Timeout copy says the request was written and may still be processed; poll/wait before retrying.
  - `send` timeout should return structured unknown/pending delivery rather than an unqualified failure, if compatible with tool contract.
- Acceptance:
  - Late response after timeout still transitions thread correctly.
  - Caller-facing text discourages duplicate prompts.

### M1 — hydrate after target scope resolution

- Status: done
- Owner: `scope_sync`
- Files likely touched:
  - `src/index.ts`
  - `test/index.test.ts` or `test/thread-manager.test.ts`
- Goals:
  - Compute/rebind/reset target scope before hydration.
  - First list after switching from child scope to root sees root sibling entries.
- Acceptance:
  - Regression proves first sync is correct, not only second sync.

### H4 — session adapter and surfaced persistence failures

- Status: done
- Owner: `persistence_adapter`
- Dependencies:
  - Prefer after H3/M1 land to reduce `thread-manager.ts` conflict.
- Files likely touched:
  - new `src/pi-session-adapter.ts`
  - `src/thread-manager.ts`
  - `src/index.ts`
  - persistence tests
- Goals:
  - Centralize `_rewriteFile`, `flushed`, materialization, session safe getters, and cross-session append.
  - Replace bare durability swallowing with one-shot degraded signal.
  - Append `thread_error` event and notify once when persistence fails.
- Acceptance:
  - Throwing persistence stub does not break lifecycle.
  - User-visible warning/event exists and is throttled.
  - SessionManager without `_rewriteFile` still uses manual materialization fallback.

### H1 — transition-triggered persistence policy

- Status: done
- Owner: `persistence_policy`
- Dependencies:
  - H4 adapter/failure handling.
- Goals:
  - Do not persist on partial-text deltas.
  - Persist on durable transitions only: registration/session capture, phase change, message_end, turn_end, close/stale/stop, archive.
  - Replace or shrink durability signature; avoid serializing large text on every refresh.
- Acceptance:
  - Streaming wait append count bounded by transitions, not 250ms poll count.
  - Restore result remains equivalent for durable states.

### H2 — hydration cache / cheap comparisons

- Status: done
- Owner: `hydration_cache`
- Dependencies:
  - M1, H1.
- Goals:
  - Cache session id/file + current path + branch length/leaf id/registry generation.
  - Skip restore when unchanged.
  - Use cheap snapshot fields before full compare fallback.
- Acceptance:
  - Second hydrate on unchanged branch does no registry parsing.
  - No missed restore after new registry entry.

### M4 — dirty flag and memory cap

- Status: done
- Owner: `memory_cap`
- Dependencies:
  - H1/H2 preferred.
- Goals:
  - Remove whole-snapshot JSON signature from refresh path.
  - Cap in-memory assistant/partial text with explicit truncation marker.
- Acceptance:
  - Oversized `message_end` retained text is bounded.
  - `detail: full` still explicit but not unbounded.

### M5/L1/L2/L4/L5 — UX and low-risk cleanup

- Status: done
- Owner: `ux_lows`
- Goals:
  - TUI Ctrl-X confirmation.
  - No-UI `/threads` prints actual list, not just count.
  - Archived threads reachable in RPC command mode.
  - Closed stop reports already closed.
  - Comment/remove duplicate parent env var.
  - Warn once for invalid env config.
  - Add loose-vs-strict schema field-set drift test.
  - Remove redundant TUI `replaceThread()` after poll unless documented.
- Acceptance:
  - Snapshot/unit tests for output and stop wording.
  - Existing UX remains observational except confirmed stop.

### M2/A2 — explicit send-state machine

- Status: done
- Owner: `state_machine`
- Dependencies:
  - H3, H1, H2.
- Goals:
  - Replace `AwaitingSend` booleans with named states and one transition function.
  - Preserve all current wait/send race tests.
- Acceptance:
  - Existing dedicated wait/send tests pass unchanged or with clearer expectations.
  - Transition table unit tests added.

### A1 — split `thread-manager.ts`

- Status: done
- Owner: `manager_split`
- Dependencies:
  - M2/A2.
- Target modules:
  - `thread-process.ts`
  - `thread-state.ts`
  - `thread-persistence.ts`
  - slim `thread-manager.ts`
- Acceptance:
  - Mostly mechanical move.
  - Public `ThreadManager` API unchanged.
  - Full check suite passes.

## Proposed implementation waves

### Wave 0 — discovery and branch-risk checks

Parallel:

- `h5_verification`
- `timeout_contract`
- `scope_sync`
- selected `ux_lows` items that avoid `thread-manager.ts`

### Wave 1 — immediate correctness

Sequential integration:

1. H3/M6
2. M1
3. H4

### Wave 2 — durability scale

Sequential integration:

1. H1
2. H2
3. M4
4. Optional compaction / H5-derived fix

### Wave 3 — maintainability

Sequential integration:

1. M2/A2 state machine
2. A1 manager split

### Wave 4 — polish and compatibility

Parallel where possible:

- Remaining M5/L lows
- Windows CI/smoke coverage
- Docs/release checklist updates

Completion notes:

- M5/L lows and documentation updates are done.
- Windows typecheck/test CI is added. The POSIX-only SIGKILL runtime check is skipped on Windows.
- Registry compaction was not added because H1 removed refresh-rate write amplification and H2 restores side-branch entries without rewriting user session files. Treat compaction as an optional future release-hardening item, not required for this remediation pass.

## Implementor prompt template

```text
You are an implementor thread for pi-threads. Work only on: <task>.

Read `plan.md` first and follow the operating model. Do not perform broad refactors.
Before editing, inspect the named files/tests. Add or update focused tests. Run the smallest relevant tests, then report:
- Summary
- Files changed
- Tests run and results
- Risks/open questions

Avoid concurrent-conflict areas unless this task explicitly requires them.
```

## Review checklist for each completed task

- [ ] Scope matches assignment.
- [ ] Tests cover the reported audit failure mode.
- [ ] Error/repair wording is agent-friendly.
- [ ] No unbounded session-file or context output introduced.
- [ ] No broad refactor hidden in behavior patch.
- [ ] `pnpm typecheck` and relevant tests pass.
- [ ] Update this plan status and notes.
