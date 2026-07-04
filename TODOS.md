# pi-threads TODOs

Goal: keep `pi-threads` as a clean, minimal background-session primitive. The
extension should expose thread capability without enforcing an orchestration
style. Users can add their own prompts, skills, templates, or extensions if they
want proactive delegation.

Non-goal: no built-in agent profiles, roles, or workflow presets.

## 1. Reduce prompt dependence

- [x] Remove proactive prompt guidance from the tool registration.
- [x] Do not add prompt guidance modes; users should customize their own agent
      prompt/context if they want different thread behavior.
- [x] Rely on the tool registry, description, and schema for model-facing
      metadata.
- [x] Shorten the tool description to something neutral, e.g.
      `Start and manage background Pi child sessions.`
- [x] Remove language that tells the model to use threads proactively.

## 2. Keep one model-facing tool

- [x] Keep a single `thread` tool with action-based input.
- [x] Do not split into `thread_start`, `thread_poll`, `thread_wait`, etc.
- [x] Keep the top-level tool surface small and stable.

## 3. Improve validation and repairability

- [x] Tighten per-action validation for required and forbidden fields.
- [x] Improve error messages so they include exact repair examples.
- [x] Include clear errors for:
  - missing required fields,
  - unexpected fields for an action,
  - invalid action names,
  - unknown thread ids/paths/task names,
  - duplicate `taskName` paths,
  - invalid `cwd`,
  - disallowed child CLI args.
- [x] Prefer errors that teach the valid shape without relying on global prompt
      instructions.

## 4. Better defaults

- [x] Auto-generate `taskName` when omitted.
  - Prefer `name` when present.
  - Otherwise derive from the prompt.
  - Fall back to a short id.
  - Ensure uniqueness and valid `lower_snake_case`.
- [x] Auto-generate a useful display name when omitted.
- [x] Keep `cwd` defaulting to the parent session cwd.
- [x] Keep `wait` timeout bounded and safe by default.
- [x] Make `poll` and `wait` results clearly state whether the thread is still
      running and what action is possible next.

## 5. Structured runtime model

- [x] Normalize start/poll/wait/send/stop/list results around a shared thread
      snapshot shape.
- [x] Include machine-readable fields such as:

```ts
{
  id: string,
  path: string,
  status: "live" | "closed",
  phase: "starting" | "busy" | "idle" | "stopping" | "failed",
  lastAssistantText?: string,
  recentEvents: ThreadEvent[],
  nextSuggestedActions: string[],
}
```

- [x] Keep prose summaries concise and secondary to structured `details`.
- [x] Ensure every action returns enough structured data for the model or UI to
      continue without prompt-specific assumptions.

## 6. Lifecycle event log

- [x] Track canonical lifecycle events internally.
- [x] Consider event names such as:
  - `thread_started`,
  - `turn_started`,
  - `tool_started`,
  - `tool_completed`,
  - `assistant_message`,
  - `turn_completed`,
  - `thread_closed`.
- [x] Use the same event log for tool results and `/threads` UI.
- [x] Keep event payloads compact and stable.

## 7. Summaries and detail control

- [x] Add summarized child results for completed threads.
- [x] Default poll output to a concise summary/tail instead of noisy transcript
      dumps.
- [x] Add an optional detail control, e.g.
      `detail: "summary" | "tail" | "full"`.
- [x] Keep full transcript/detail access explicit and opt-in.

## 8. Explicit context passing

- [ ] Keep the default context behavior explicit and minimal: children do not
      inherit the parent conversation automatically.
- [ ] Consider limited opt-in context modes later:
  - `none`,
  - `recent`,
  - `summary`.
- [ ] Avoid hidden parent-context injection.
- [ ] Make child prompts self-contained unless the caller explicitly requests
      context transfer.

## 9. Durability and navigation

- [ ] Improve resume semantics so managed thread ids/paths survive parent reloads
      where possible.
- [ ] Lean on Pi's native session model instead of inventing a parallel one:
      session files, session ids, parent-session headers, tree entries, labels,
      branch summaries, and session names should remain the source of truth where
      possible.
- [ ] Add first-class `resume` support inside the same `thread` tool.
  - Resume/reconnect a managed child from its saved Pi session file.
  - Allow closed/stopped children to be reopened as managed live threads when
    safe.
  - Preserve the existing canonical thread path and display name when resuming a
    managed child.
  - Do not expose raw `--session` through `start.args`; implement resume as a
    validated thread action.
- [ ] Add first-class `fork` support inside the same `thread` tool.
  - Fork from a parent session, a child session, or a selected entry id where Pi
    supports it.
  - Prefer Pi's native fork/clone/session APIs over custom transcript copying.
  - Preserve parent-child linkage through Pi's `parentSession` metadata where
    possible.
  - Do not expose raw `--fork` through `start.args`; implement fork as a
    validated thread action.
- [ ] Add archive/cleanup behavior for completed or stale threads without
      deleting history by default.
  - Treat archive as a visibility/lifecycle state for managed threads.
  - Keep the underlying Pi session file unless the user explicitly asks for
    deletion.
  - If deletion is added later, prefer Pi's existing session deletion/trash
    behavior when available.
- [ ] Improve `/threads` browser with:
  - better filters,
  - event timeline,
  - summaries,
  - clearer live/closed/stale states,
  - archived-thread visibility toggles,
  - resume/fork/archive actions,
  - easier parent/child navigation.

## 10. User-facing invocation

- [ ] Add a manual shorthand command, e.g.
      `/thread start Find the auth refresh code`.
- [ ] Consider optional mention-style invocation, e.g.
      `@thread Find the auth refresh code`.
- [ ] Ensure users can directly spawn/manage threads without depending on
      autonomous model behavior.
- [ ] Keep manual invocation thin; it should map to the same underlying `thread`
      primitive.

## 11. Safety and resource controls

- [ ] Keep per-session concurrency limits.
- [ ] Keep recursive thread depth limits.
- [ ] Add optional timeout/idle cleanup for stale live children.
- [ ] Ensure children never loosen parent restrictions.
- [ ] Continue validating and allowlisting child CLI args.
- [ ] Make shutdown behavior predictable for live children.

## Suggested implementation order

1. Registry-only prompt metadata and shorter neutral description.
2. Better validation and repair errors.
3. Auto-generated `taskName` and display name.
4. Shared structured snapshot shape for all actions.
5. Lifecycle event log cleanup.
6. Summary/detail controls.
7. Explicit context passing modes.
8. Pi-native resume/fork/archive semantics.
9. `/threads` browser improvements.
10. Manual shorthand invocation.
