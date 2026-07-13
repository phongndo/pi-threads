# Example workflow: explicit context handoff

This is a user-authored pattern, not a built-in `pi-dispatch` role or preset.

Use it when one child’s result should seed another child. Children do not share
conversation context, so the parent must pass the handoff context explicitly.

## Steps

1. Start the first child with a self-contained discovery prompt.
2. Wait or poll for a summary.
3. Copy only the needed facts into the next child prompt.
4. Start or send to the next child.

## Tool-call sketch

Discovery:

```json
{
  "action": "start",
  "name": "Schema discovery",
  "taskName": "schema_discovery",
  "prompt": "Inspect the current thread tool schema and summarize action names, required fields, optional fields, and enum values. Do not edit files. Return concise bullets with source paths."
}
```

```json
{ "action": "wait", "id": "/root/schema_discovery", "detail": "summary" }
```

Handoff:

```json
{
  "action": "start",
  "name": "Docs wording check",
  "taskName": "docs_wording_check",
  "prompt": "Use this handoff context from schema_discovery:\n- Actions: start, list, poll, send, stop, wait, resume, fork, archive\n- Detail enum: summary, tail, full\n- Send mode enum: prompt, steer, follow_up\n\nCheck the workflow docs for wording that conflicts with those facts. Do not edit files. Report exact paths and replacement wording."
}
```

## Why this matters

Without the handoff block, `docs_wording_check` would not know what
`schema_discovery` found. The parent is the coordinator and context bridge.
