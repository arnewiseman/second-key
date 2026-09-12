# Second Key development

Read `prd.MD`, `goal.MD`, and `docs/handoff.md` first. The v2 two-person PRD wins over stale three-person text in the brief. Preserve the original requirements documents.

- The model only parses/explains; deterministic YAML rules decide policy. Never execute grants or call a cloud provider API.
- Arne owns `src/engine/*`, `policy/*`, IAM/inbound fixtures and engine tests.
- Alex owns server/webhook/router, `src/ambiguous/*`, `src/record/*`, webhook fixtures and loop tests.
- Shared types/ports/config/dependency changes require agreement between both owners after handoff.
- Every prompt lives in `src/engine/prompts.ts`. No hardcoded model name. Runtime dependencies: Node built-ins, OpenAI SDK, YAML parser only.
- Read `docs/ambiguous-api.md` and verify the current official spec before expanding the client; do not invent endpoints or event payload fields.
- Keep secrets, local records, node_modules and generated smoke artifacts out of Git.
- Use `npm run check` and `npm run smoke` for integrated verification. Clearly distinguish offline stub evidence from live acceptance.
- Work directly on main as requested by the PRD. Stage only task-owned files, preserve others' edits, and never force-push.

For non-trivial tasks, use a primary manager and delegate a useful bounded independent lane after inspecting the worktree. One writer per overlapping file set. Workers report outcome, inspected/changed files, verification, risks and next steps; they must not stage, commit, or perform remote writes. The primary agent owns integration, final verification and Git operations.
