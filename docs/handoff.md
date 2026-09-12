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

Implemented: read-only validated fixture resolver, explicit resource metadata, strict parse/explain transport, trusted identity/ID binding, all six YAML conditions plus `REQUEST-VALIDATION`, bounded least-privilege matching, and the six-section document. `src/engine/index.ts` now exports the real engine; smoke explicitly imports the stub.

`test/engine-real.test.ts` exercises all three scenarios using hand-authored model responses and the real evaluator. The refusal integration invokes the real engine and router, verifies both rule IDs in the email and no task. Separately, all three fixture parses and expected policy outcomes passed against live DeepSeek using fake, separate requester/approver identities. No workspace writes were made. `MODEL_PROVIDER=deepseek` selects `DEEPSEEK_MODEL`/`DEEPSEEK_API_KEY`; OpenAI remains the default provider.

The engine reads the existing `APPROVER_USER_ID` and `APPROVER_EMAIL` variables, or accepts an engine-local `createAnalyzer({ complete, approver, now? })`. Alex must use the same trusted approver for engine and router. Missing/invalid runtime configuration aborts; missing approver in the injectable factory blocks. The frozen shared types and ports are unchanged. Reference dates come from the injected clock (processing time by default), never an untrusted email header. See `src/engine/README.md` for supported evidence and remaining live checks.

## Alex: workspace loop

1. Build a `Workspace` adapter over the verified `AmbiguousClient` methods. `createDocument` returns an ID; `documentUrl(id)` builds the verified UI URL. Ensure the approver can open the doc. Keep every external write in the client.
2. Wire `createApp({ secret, enqueue })` to durable storage and background processing. `enqueue` must persist quickly, then return for a 200 within two seconds. Add delivery deduplication, serialized per-record processing, bounded intake, restart recovery, and tests. Signature age checking alone does not prevent repeat deliveries within the five-minute window.
3. Normalize the real email event into `{ text, from }`, fetch email details where necessary, then invoke the router. Do not route arbitrary `data` straight into business logic. Use `src/engine/stub.ts` for offline loop development; the real engine is available at `src/engine/index.ts`.
4. Inspect the actual event list for task completion. If unavailable, poll outstanding task IDs every three seconds without overlapping polls, through the same approval handler. Stop timers on shutdown. The client includes task/comments reads; the scheduler/approval handler is still TODO.
5. Require an explicit approval comment from the configured human approver, task assignment to that approver, and a decision for this exact record. `completed_at` also appears on cancelled tasks; it is not proof of approval and contains no actor. Never treat task completion or a request's claimed prior approval as approval. Record actor, timestamp and comment.
6. After verified approval, book the agreed change window via the real calendar ID, email scope and expiry, and persist each side effect and final state. Make repeated approval events safe. Do not claim any IAM grant was executed. Retain failure information and a recovery path for partially completed external writes.
7. Validate the live refusal flow: both rule IDs in email, no task, final refused record. The engine test covers this through the router with mocked model transport, and fixture parsing has passed with live DeepSeek. Real mail delivery remains unverified.

JSON snapshots are atomic but not transactional with external writes. Documents/tasks/calendar POSTs have no verified idempotency contract: the client does not blindly retry them. Reconcile ambiguous outcomes before replay. Mail retries use a stable idempotency key.

## Integration gates together

| PRD gate | Scaffold evidence | Still required |
| --- | --- | --- |
| P0-1 webhook | Raw HMAC/timestamp checks and HTTP tests using synthetic payload | Real payload, durable wiring, replay deduplication, real latency check |
| P0-2 parse | Real engine, strict parser; all three fixture cases verified offline and with live DeepSeek | Real inbound identity mapping and broader request acceptance |
| P0-3 doc | Six-section Markdown renderer and verified client method | Live doc visible to approver |
| P0-4 task | Intake port/router, separate-human guard | Live assignment, linked doc, trusted identity mapping |
| P0-5 refusal | Live DeepSeek refusal case; real engine + router tested offline, both rule IDs, no task | Real refusal email delivery |
| P0-6 closeout | Calendar/mail client methods | Approval attribution, idempotent closeout, calendar/email/record chain |

Run `npm run check && npm run smoke` before each handoff. Then perform the six PRD demo shots with separate accounts. Only attempt expiry after the complete core loop is green. No public record page, second cloud, retroactive audit, UI, or demo mode is in scope.
