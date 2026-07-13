# Example workflow: review loop

This is a user-authored pattern, not a built-in `pi-threads` role or preset.

Use it when the parent has a draft, patch, or plan and wants an isolated second
pass before finalizing.

## Steps

1. Parent creates or describes the draft.
2. Start a child with the exact draft context and review criteria.
3. Wait or poll for the child summary.
4. Parent decides which feedback to apply.
5. Optionally send a follow-up to the same child with the revised draft.

## Tool-call sketch

```json
{
  "action": "start",
  "name": "Docs second pass",
  "taskName": "docs_second_pass",
  "prompt": "Review this docs draft for accuracy against the current tool contract. Context:\n- Changed files: docs/tool-contract.md, docs/workflow-authoring.md\n- Constraint: docs-only; no README/source/test edits\n\nCheck for stale behavior, role-like wording, broken relative links, and missing safety notes. Do not edit files. Return exact findings and suggested wording."
}
```

```json
{ "action": "wait", "id": "/root/docs_second_pass", "detail": "summary" }
```

If the parent revises the draft and wants another pass:

```json
{
  "action": "send",
  "id": "/root/docs_second_pass",
  "message": "I applied the link and wording fixes. Re-check only the changed sections and report any remaining blockers.",
  "mode": "prompt"
}
```

## Parent decision rule

Treat child output as advice, not an automatic approval gate. The parent remains
responsible for checking the final diff and constraints.
