# Example workflow: parallel investigation

This is a user-authored pattern, not a built-in `pi-dispatch` role or preset.

Use it when several independent questions can be answered in parallel and the
parent can merge the findings.

## Steps

1. Start one child per independent question. Make each prompt self-contained and
   state whether edits are allowed.
2. Continue parent-side work while children run.
3. Poll or wait with summary detail.
4. Merge findings in the parent conversation.
5. Stop obsolete live work and archive completed threads if desired.

## Tool-call sketch

```json
{
  "action": "start",
  "name": "Docs contract scan",
  "taskName": "docs_contract_scan",
  "prompt": "Inspect the tool-contract documentation against the current README/source behavior. Do not edit files. Report exact paths, stale claims, and proposed wording."
}
```

```json
{
  "action": "start",
  "name": "Workflow examples scan",
  "taskName": "workflow_examples_scan",
  "prompt": "Inspect workflow example docs for unclear or role-like language. Do not edit files. Report exact paths, stale claims, and proposed wording."
}
```

```json
{ "action": "wait", "id": "/root/docs_contract_scan", "timeoutMs": 30000 }
```

```json
{ "action": "poll", "id": "/root/workflow_examples_scan", "detail": "summary" }
```

## Parent synthesis prompt

After both children return, the parent should quote the relevant findings before
acting:

```md
Merge these findings:

- docs_contract_scan: <summary from poll/wait result>
- workflow_examples_scan: <summary from poll/wait result>

Decide the minimal docs-only edits needed. Do not assume either child saw the
other child’s output.
```
