# Arne + Alex handoff

## Current integration

Alex’s `150fc91` intake, workspace adapter and approval foundations are pulled into Arne’s real engine. The executable server now wires durable webhook intake, trusted email lookup, the router and real engine, a non-overlapping three-second approval poll, calendar booking, decision mail and audit closeout. Frozen `src/types.ts` and `src/ports.ts` are unchanged. The original PRDs are preserved; `prd-alex.md` contains historical planning checkboxes, while this handoff describes the integrated state.

No further implementation handoff from Alex is needed for the core loop. Both owners still need to validate the live workspace using their actual distinct accounts. No live workspace writes or messages were sent during this integration.

## Evidence and remaining acceptance

| PRD gate | Implemented and tested | Still required live |
| --- | --- | --- |
| P0-1 webhook | Raw HMAC/freshness checks; durable bounded intake before ACK; conflicting/duplicate delivery handling; serialized recovery | Real payload/signing and field paths; under-two-second ACK measurement |
| P0-2 parse | Real engine, strict model contract, trusted identity, fixture resolver and deterministic YAML; all three fixtures passed with live DeepSeek | Real inbound sender mapping and demo request |
| P0-3 doc | Six-section Markdown, verified client endpoint and adapter | Approver can open the actual document |
| P0-4 task | Exact assignment, linked doc, separate-human guard | Actual task creation and visibility |
| P0-5 refusal | Real evaluator routes both blocking rule IDs to mail and creates no task | Real refusal mail delivery |
| P0-6 closeout | Attributable approval; complete comment pagination; future calendar window; stable mail retries; persisted scope/expiry/audit; crash/duplicate tests | Human comment, real event and received mail, reconstructable chain |

`test/runtime.test.ts` exercises a signed HTTP delivery through the real engine, workspace client and closeout with mocked model/API responses. It also verifies refusal, duplicate deliveries for one email, spoofed requester identity and configuration guards. `test/closeout.test.ts` covers approval attacks, concurrent runs, partial failures and restart recovery. `npm run smoke` remains strictly offline stub intake; it is not live acceptance. Run `npm run check && npm run smoke` before handoff.

## Live setup

1. Provision Reeve and both humans using the starter-kit flow. Use the agent key for routine calls; keep all credentials local. Read [the verified API contract](ambiguous-api.md).
2. Read the authenticated event list and capture a real `email.received` delivery with secrets removed. Verify the raw-body HMAC recipe and set `WEBHOOK_EMAIL_ID_PATH` relative to `data` and `WEBHOOK_DELIVERY_ID_PATH` relative to the envelope. The checked-in webhook fixture and integration test payload are synthetic. Do not infer real fields from them.
3. Configure the actual requester ID/email and different human approver ID/email. Runtime requires both ID and email to match authenticated fetched mail; external participants with empty IDs are rejected. Never take identity from model output.
4. Choose a model provider. DeepSeek works via `MODEL_PROVIDER=deepseek`, `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL`; an OpenAI key is not required in that mode. Fake identities are fine for isolated parser tests, but cannot assign live tasks.
5. Configure a real `CALENDAR_ID`, agreed future `CHANGE_START_AT` and `CHANGE_END_AT` (ISO timestamps with timezone), `WEBHOOK_SECRET`, `AMBIGUOUS_AGENT_KEY`, and `REEVE_ENABLED=1`. Start one process with `npm start`; expose/register the webhook using the actual starter-kit setup. Missing activation leaves only the health server and 503 webhook responses.
6. Submit the happy path, open the document as the approver, and comment exactly `Approved.` on the assigned task. Verify calendar, received mail and local record. Task completion or quoted/qualified approval is not sufficient.
7. Submit the two alternative fixtures and record the remaining PRD demo shots. Confirm refusal mail names both rules and creates no approval task.

The frozen contract models the requester as the grantee. If the demo needs a separate pipeline service-account grantee, agree the contract change first; do not describe the current recommendation as an exact service-account binding. Fixture permissions cover bounded object-create/read and log-read needs, not arbitrary IAM. Expiry lifecycle remains stretch scope, after core live acceptance.

## Recovery and operating limits

Run one process per `RECORD_DIR`. Intake and audit snapshots are flushed and atomically replaced; pending intake is capped at 100. The HTTP ACK follows durable acceptance, and no model/API call runs on that request path. The timer serializes processing and approval checks; slow upstream calls delay later jobs rather than adding overlapping work.

Queued intake resumes on restart. Interrupted `processing` jobs become `failed` with a reconciliation marker, and failed jobs do not automatically run again. Inspect the intake JSON, associated decision record and actual workspace artifacts before changing job state. An `analyzing` decision record deliberately blocks replay because document/task POSTs have no verified idempotency contract. Repair the record using verified remote IDs and an appended audit event before requeueing; never delete it simply to repeat external writes.

Closeout journals live under `RECORD_DIR/closeout/` and snapshot the approval evidence, agreed window, expiry and operation outcomes. A `calendar: pending` journal means the remote outcome is uncertain: stop the service, inspect the actual calendar, and reconcile before any replay. If the event exists, record its verified ID and completed status in the journal. Only reset to an unattempted state after proving that no event was created; the saved window must still be future. Preserve the evidence and audit history. There is no automated reconciliation command.

Mail retry uses the original snapshot and stable record-based idempotency key without creating another calendar event. A successful mail followed by final record-save failure resumes record closeout without resending. Do not edit the stored request, recommendation or approval to change a pending send. Records are local files, not a transactional database or tamper-proof audit service.

The integration Endor SAST/secrets scan found no issues. The configured OpenRouter free reviewer returned 403 and could not review; independent agent review plus repository inspection and regression tests were used, including a fix for a stale saved calendar window on restart. Live workspace acceptance remains unclaimed.
