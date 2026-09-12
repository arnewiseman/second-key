# Arne + Alex handoff

The scaffold ends at the split point in PRD section 6. Continue on `main`, commit only your files, pull before pushing, and do not change the frozen shared contracts without agreeing together. Neither person needs to wait on the other's implementation.

## First: integration spike together

- [ ] Provision Reeve and both human accounts using the actual starter-kit flow. Keep credentials in `.env`.
- [ ] Use `GET /api/webhooks/event-types` to capture the actual available events. The OpenAPI schema does not enumerate them.
- [ ] Capture and redact one real `email.received` delivery into `fixtures/webhooks/`; the checked-in payload is explicitly synthetic and verifies only signing/envelope behavior.
- [ ] Verify the signing recipe against that delivery. Keep raw bytes until authentication succeeds.
- [ ] Create one real document with the client, open its URL as Alex, and verify access/sharing. No live writes were made during scaffolding.
- [ ] Confirm which real field identifies the email sender and how to map it to a trusted `Principal`. Never obtain requester identity from the model's output.
- [ ] Agree whether the requested grantee is the requester or the pipeline service account: the frozen PRD has only `requester`, no separate grantee. The scaffold follows that contract; resolve this before claiming an exact service-account binding.

## Arne: engine and evidence

1. Review the hand-authored IAM fixtures. They intentionally contain bounded example permissions. Add a read-only fixture resolver; do not call GCP.
2. In `src/engine/prompts.ts`, complete the strict JSON parse/explain prompts. Read `OPENAI_MODEL` from env. Validate model output at runtime; bind `requester`, `raw_text`, source and stable request ID from trusted application input.
3. Implement all six YAML conditions in deterministic TypeScript. Treat missing/unknown roles, resources, incomplete justification, invalid/negative duration, and ambiguous permissions explicitly; do not turn uncertainty into a pass.
4. Cover fixture 01 warnings + Object Creator/30-day proposal, fixture 02 both blocking rule IDs + no recommendation, fixture 03 clean pass + Logging Viewer/7 days. Explain the overwrite limitation of Object Creator.
5. Keep the body renderer's six headings; model rationale cannot alter findings, recommendation, or refusal. Replace the export in `src/engine/index.ts` when ready.

`SELF-APPROVAL` needs configured approver context despite the frozen `analyze()` argument only containing sender/text. Agree configuration/injection together; the router already enforces the actual requester/approver separation before any writes.

## Alex: workspace loop

1. Build a `Workspace` adapter over the verified `AmbiguousClient` methods. `createDocument` returns an ID; `documentUrl(id)` builds the verified UI URL. Ensure the approver can open the doc. Keep every external write in the client.
2. Wire `createApp({ secret, enqueue })` to durable storage and background processing. `enqueue` must persist quickly, then return for a 200 within two seconds. Add delivery deduplication, serialized per-record processing, bounded intake, restart recovery, and tests. Signature age checking alone does not prevent repeat deliveries within the five-minute window.
3. Normalize the real email event into `{ text, from }`, fetch email details where necessary, then invoke the router. Do not route arbitrary `data` straight into business logic. Use `src/engine/stub.ts` while Arne works.
4. Inspect the actual event list for task completion. If unavailable, poll outstanding task IDs every three seconds without overlapping polls, through the same approval handler. Stop timers on shutdown. The client includes task/comments reads; the scheduler/approval handler is still TODO.
5. Require an explicit approval comment from the configured human approver, task assignment to that approver, and a decision for this exact record. `completed_at` also appears on cancelled tasks; it is not proof of approval and contains no actor. Never treat task completion or a request's claimed prior approval as approval. Record actor, timestamp and comment.
6. After verified approval, book the agreed change window via the real calendar ID, email scope and expiry, and persist each side effect and final state. Make repeated approval events safe. Do not claim any IAM grant was executed. Retain failure information and a recovery path for partially completed external writes.
7. Validate the refusal flow with Arne's real fixture-02 engine: both rule IDs in email, no task, final refused record. The router test currently injects this analysis.

JSON snapshots are atomic but not transactional with external writes. Documents/tasks/calendar POSTs have no verified idempotency contract: the client does not blindly retry them. Reconcile ambiguous outcomes before replay. Mail retries use a stable idempotency key.

## Integration gates together

| PRD gate | Scaffold evidence | Still required |
| --- | --- | --- |
| P0-1 webhook | Raw HMAC/timestamp checks and HTTP tests using synthetic payload | Real payload, durable wiring, replay deduplication, real latency check |
| P0-2 parse | Three email fixtures, frozen types, fixture-01 stub | Actual validated parser for all three |
| P0-3 doc | Six-section Markdown renderer and verified client method | Live doc visible to approver |
| P0-4 task | Intake port/router, separate-human guard | Live assignment, linked doc, trusted identity mapping |
| P0-5 refusal | Router branch tested with injected blocked analysis | Real engine case + real refusal email |
| P0-6 closeout | Calendar/mail client methods | Approval attribution, idempotent closeout, calendar/email/record chain |

Run `npm run check && npm run smoke` before each handoff. Then perform the six PRD demo shots with separate accounts. Only attempt expiry after the complete core loop is green. No public record page, second cloud, retroactive audit, UI, or demo mode is in scope.
