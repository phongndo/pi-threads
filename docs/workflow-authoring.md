# Workflow authoring on top of `pi-threads`

`pi-threads` is intentionally small: it exposes background Pi sessions through
one `thread` tool and leaves orchestration style to you. It ships no built-in
roles, agent profiles, planner/reviewer/worker graph, or workflow presets.

Use this guide when you want to write a project prompt, skill, prompt template,
or companion extension that teaches Pi how your team wants to use threads.

## Authoring principles

1. **Keep child prompts self-contained.** A child receives exactly the prompt you
   send with `start` or `send`; it does not inherit the parent conversation.
2. **Name work for stable references.** Use clear `name` values for humans and
   stable `taskName` values for paths when later steps will refer to a thread.
3. **Fan out only independent work.** Threads are useful when tasks can progress
   without sharing hidden state.
4. **Fan in through the parent.** Poll or wait for children, read their
   structured summaries, then synthesize in the parent conversation.
5. **Pass context explicitly between steps.** If one child result should feed
   another child, paste the needed summary into the next prompt or `send`.
6. **Prefer summaries first.** Use `detail: "summary"` by default, `tail` for
   debugging output, and `full` only when the retained assistant output is
   needed.
7. **Close the loop.** Stop work that is no longer needed and archive completed
   or stale threads when you want a quieter active list.

## Workflow building blocks

### Fan-out

Start multiple children with independent prompts:

```json
{
  "action": "start",
  "name": "Config surface scan",
  "taskName": "config_scan",
  "prompt": "Inspect configuration-related docs and source. Report exact findings and do not edit files."
}
```

```json
{
  "action": "start",
  "name": "CLI surface scan",
  "taskName": "cli_scan",
  "prompt": "Inspect CLI/tool-call docs and source. Report exact findings and do not edit files."
}
```

### Gate

Wait for a child when a later step depends on it:

```json
{ "action": "wait", "id": "/root/config_scan", "timeoutMs": 30000 }
```

Use `poll` for a non-blocking status check:

```json
{ "action": "poll", "id": "/root/cli_scan", "detail": "summary" }
```

### Fan-in

After children report back, merge in the parent. Do not assume the children saw
each other's conversation. The parent should quote or summarize the relevant
findings before making a decision.

### Handoff

Start the next child with explicit context:

```json
{
  "action": "start",
  "name": "Compatibility check",
  "taskName": "compat_check",
  "prompt": "Context from previous scans:\n- Config scan found ...\n- CLI scan found ...\n\nCheck whether these findings conflict with the current public tool contract. Report exact fixes only."
}
```

### Branch or resume

Use `fork` when the next step should continue from an existing Pi session tree.
Use `resume` when a saved managed child should become live again. Neither action
sends a hidden prompt; use `send` if you want the branch or resumed thread to do
new work.

```json
{ "action": "fork", "id": "/root/compat_check", "name": "Compatibility branch" }
```

```json
{
  "action": "send",
  "id": "compatibility_branch",
  "message": "Continue from this branch and verify the final docs wording.",
  "mode": "prompt"
}
```

## Suggested workflow spec shape

When writing a reusable workflow document, keep it declarative. A practical
shape is:

```md
# Workflow: <name>

Goal: <what the parent should accomplish>

Use threads when:

- <condition for parallel or isolated work>

Do not use threads when:

- <condition where the parent should work directly>

Child prompt requirements:

- Include the target files, constraints, and expected output.
- State whether the child may edit files.
- Ask for exact paths and concise findings.

Coordination:

- Start at most <N> live children at a time.
- Wait or poll with summary detail first.
- Pass any needed handoff context explicitly.

Cleanup:

- Stop obsolete live work.
- Archive completed threads when they are no longer active inputs.
```

This kind of workflow describes policy for Pi to follow without adding any
roles to `pi-threads` itself.

## Prompt policy snippet

You can add a short policy like this to a project prompt or prompt template:

```md
When useful, you may use the `thread` tool to run independent Pi child sessions
in the background. Use threads only for work that can be described in a
self-contained prompt. Children do not inherit this conversation, so include all
needed context, constraints, and expected output. Keep no more than a few live
threads at once, poll or wait with summary detail first, synthesize results in
the parent conversation, and stop or archive threads that are no longer needed.
```

That snippet is a user-authored policy. It is not injected by `pi-threads`.

## Anti-patterns

- Starting a child with “continue from above” or “look at our chat” without
  context.
- Using `detail: "full"` as the default for every poll.
- Passing one child’s implicit assumptions to another child without quoting the
  relevant findings.
- Leaving obsolete live threads running after the parent no longer needs them.
- Treating example workflow names as built-in roles or presets.

## Examples

Small workflow examples live in [`docs/examples/workflows`](examples/workflows):

- [`parallel-investigation.md`](examples/workflows/parallel-investigation.md)
- [`review-loop.md`](examples/workflows/review-loop.md)
- [`context-handoff.md`](examples/workflows/context-handoff.md)
