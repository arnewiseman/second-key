# Arne + Alex handoff

## Current integration

Alex’s `150fc91` intake, workspace adapter and approval foundations are pulled into Arne’s real engine. The executable server now wires durable webhook intake, trusted email lookup, the router and real engine, a non-overlapping three-second approval poll, calendar booking, decision mail and audit closeout. Frozen `src/types.ts` and `src/ports.ts` are unchanged. The original PRDs are preserved; `prd-alex.md` contains historical planning checkboxes, while this handoff describes the integrated state.

No further implementation handoff from Alex is needed for the core loop. The live rehearsal has completed Alex's attributable approval, calendar/mail closeout and the refusal path through the actual workspace. The closing email, calendar event and refusal email were viewed in Arne's UI. The original code integration used mocked workspace calls; the subsequent real workspace evidence is described below. The demo is rendered, verified and delivered.

### Live rehearsal progress

The real runtime is enabled on `127.0.0.1:3107`, with a temporary Cloudflare tunnel delivering the registered webhook. A real signed email event was accepted, and its authoritative `body_markdown` was fetched successfully. DeepSeek parsed two synthetic demo emails sent through the real workspace. The first was refused with `REQUEST-VALIDATION` because added “IAM fixtures” wording triggered the bounded request matcher; a clarified second request produced the complete deterministic analysis and the approval task. The optional model explanation was unavailable for that proposal; deterministic analysis still completed.

The current decision is `approved`. Arne can open the [actual analysis document](https://app.ambiguous.ai/docs/2e4d2b9e-4561-42cc-9c7a-0b0ce3854922). The [actual approval task](https://app.ambiguous.ai/tasks/1812a478-fddf-4802-aac2-318941a69fcb) is assigned to Alex; Arne's account was denied access to its task UI. Alex posted the actual approval, returned as `<p>Approve</p>` with comment ID `5028c7d5-dc7a-4370-a41f-e57afe6e626f`, the correct author ID, and identical created/updated timestamps of `2026-09-12T22:58:52.511Z`.

The live comment required a narrow compatibility change: the approval allowlist now also accepts its existing phrases inside exactly one attribute-free paragraph wrapper. Other HTML, qualified statements and invalid attribution remain rejected. After the runtime restarted, the same decision completed closeout: calendar event `e1f397dc-5327-4a0b-ba8a-8d31295759e4` was created at `2026-09-12T23:03:31Z`, and closing mail `c40d84ed-b936-4ec6-a705-26e0e51a8c93` was sent at `2026-09-12T23:03:33Z`. The approved expiry is `2026-10-14T17:00:00.000Z`. Arne received and viewed the closing email. He also viewed the calendar event after explicitly authorizing a viewer permission on Reeve's otherwise private demo calendar; that permission write returned 201. The cloud permissions remain local fixture data and no cloud grant was executed.

The explicitly authorized synthetic Owner/claimed-prior-approval request was also processed live. Record `eabf5c05a01652d30d0bd5b0742c437e9c4bf23350eb66d8126181597b1fd2b4` is `refused` with `NO-BASIC-ROLES`, `SEP-DUTIES` and `REQUEST-VALIDATION`, and no approval task was created. Arne's received refusal email was viewed and recorded.

## Evidence and remaining acceptance

| PRD gate | Implemented and tested | Still required live |
| --- | --- | --- |
| P0-1 webhook | Raw HMAC/freshness checks; durable bounded intake before ACK; conflicting/duplicate delivery handling; serialized recovery; real signed delivery and field paths verified | Under-two-second ACK measurement |
| P0-2 parse | Real engine, strict model contract, trusted identity, fixture resolver and deterministic YAML; all three fixtures passed with live DeepSeek; real sender lookup and two live demo parses verified | Preserve the bounded request wording in the final take; optional explanation remains unavailable for the current proposal |
| P0-3 doc | Six-section Markdown, verified client endpoint and adapter; actual document created and readable by Arne | Final demo UI check of the linked document; Alex's document-read view has not been recorded |
| P0-4 task | Exact assignment, linked doc, separate-human guard; actual task created and Alex's attributed comment verified | Capture the real task/comment evidence; Arne's task UI access was denied |
| P0-5 refusal | Actual Owner/claimed-prior-approval request refused with both policy rules plus `REQUEST-VALIDATION`; no task; received refusal mail viewed and recorded; final footage QA passed | None for the recorded refusal path |
| P0-6 closeout | Alex's actual approval verified; real calendar event and received closing mail viewed by Arne; local record approved with expiry and audit chain; crash/duplicate tests; final footage QA passed | None for the recorded closeout path |

`test/runtime.test.ts` exercises a signed HTTP delivery through the real engine, workspace client and closeout with mocked model/API responses. It also verifies refusal, duplicate deliveries for one email, spoofed requester identity and configuration guards. `test/closeout.test.ts` covers approval attacks, concurrent runs, partial failures and restart recovery. The live paragraph-wrapper fix passed typechecking, all 75 tests and offline smoke, including negative HTML and attribution cases. `npm run smoke` remains strictly offline stub intake; it is not live acceptance. Run `npm run check && npm run smoke` before handoff.

## Live setup

The identities, live event mapping, model and running service are configured for the current rehearsal. The following steps remain the setup/rehearsal checklist for restarting or reproducing it; keep the configured change window future before accepting approval.

1. Provision Reeve inside the existing human-created workspace and use distinct human accounts. Do not run CLI `auth signup` to join an existing workspace: it creates a separate provisional workspace. Use the agent key for routine calls; keep all credentials local. Read [the verified API contract](ambiguous-api.md).
2. Read the authenticated event list and capture a real `email.received` delivery with secrets removed. Verify the raw-body HMAC recipe and set all three field paths relative to the complete envelope. The verified live mapping is `WEBHOOK_EVENT_TYPE_PATH=type`, `WEBHOOK_EMAIL_ID_PATH=resourceId`, `WEBHOOK_DELIVERY_ID_PATH=id`. The original webhook fixture is synthetic; `fixtures/webhooks/email-received.live-redacted.json` preserves the redacted structure captured from a real signed delivery.
3. Configure the actual requester ID/email and different human approver ID/email. Runtime requires both ID and email to match authenticated fetched mail; external participants with empty IDs are rejected. Never take identity from model output.
4. Choose a model provider. DeepSeek is configured for the live rehearsal via `MODEL_PROVIDER=deepseek`, `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL`; an OpenAI key is not required in that mode. Fake identities are fine for isolated parser tests, but cannot assign live tasks.
5. Configure a real `CALENDAR_ID`, agreed future `CHANGE_START_AT` and `CHANGE_END_AT` (ISO timestamps with timezone), `WEBHOOK_SECRET`, `AMBIGUOUS_AGENT_KEY`, and `REEVE_ENABLED=1`. Start one process with `npm start`; expose/register the webhook using the actual starter-kit setup. Missing activation leaves only the health server and 503 webhook responses.
6. Submit the happy path, open the document as the approver, and comment exactly `Approved.` on the assigned task. Verify calendar, received mail and local record. Task completion or quoted/qualified approval is not sufficient.
7. Submit the two alternative fixtures and record the remaining PRD demo shots. Confirm refusal mail names both rules and creates no approval task.

The frozen contract models the requester as the grantee. If the demo needs a separate pipeline service-account grantee, agree the contract change first; do not describe the current recommendation as an exact service-account binding. Fixture permissions cover bounded object-create/read and log-read needs, not arbitrary IAM. Expiry lifecycle remains stretch scope, after core live acceptance.

## Recovery and operating limits

Run one process per `RECORD_DIR`. Intake and audit snapshots are flushed and atomically replaced; pending intake is capped at 100. The HTTP ACK follows durable acceptance, and no model/API call runs on that request path. The timer serializes processing and approval checks; slow upstream calls delay later jobs rather than adding overlapping work.

Queued intake resumes on restart. Interrupted `processing` jobs become `failed` with a reconciliation marker, and failed jobs do not automatically run again. Inspect the intake JSON, associated decision record and actual workspace artifacts before changing job state. An `analyzing` decision record deliberately blocks replay because document/task POSTs have no verified idempotency contract. Repair the record using verified remote IDs and an appended audit event before requeueing; never delete it simply to repeat external writes.

Closeout journals live under `RECORD_DIR/closeout/` and snapshot the approval evidence, agreed window, expiry and operation outcomes. A `calendar: pending` journal means the remote outcome is uncertain: stop the service, inspect the actual calendar, and reconcile before any replay. If the event exists, record its verified ID and completed status in the journal. Only reset to an unattempted state after proving that no event was created; the saved window must still be future. Preserve the evidence and audit history. There is no automated reconciliation command.

Mail retry uses the original snapshot and stable record-based idempotency key without creating another calendar event. A successful mail followed by final record-save failure resumes record closeout without resending. Do not edit the stored request, recommendation or approval to change a pending send. Records are local files, not a transactional database or tamper-proof audit service.

The integration Endor SAST/secrets scan found no issues, and the targeted approval-file scan after the live compatibility fix also reported no problems. The configured OpenRouter free reviewer returned 403; native independent review found no blockers, alongside repository inspection and regression tests. Live evidence covers the approval/closeout and refusal paths, including Arne's actual calendar and received-mail views. Remaining acceptance details are listed in the table above. The corrected polished demo is `demo/second-key-demo.mp4` with matching subtitles: 85 seconds, 1920×1080, silent with captions, animated title cards, chapter labels and fades. The initial edit contained Terminal footage and a clipped draft-email capture missed by sparse previews; the entire affected scene is removed. The revised output was reviewed at two frames per second across its full duration, with no Terminal footage observed. Raw recordings and editing files remain in ignored `data/demo/`.
