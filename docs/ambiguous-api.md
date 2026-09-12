# Ambiguous integration contract

Owner: **Alex**. Checked 2026-09-12 against the [live OpenAPI specification](https://app.ambiguous.ai/api/openapi.json), version `3e72fc413515b67af7472056bfbf28da5bcd8515`, and the [official agent recipes](https://www.ambiguous.ai/agents/recipes). The spec wins over PRD examples and marketing examples. Re-fetch it during the shared integration spike.

All runtime calls use `Authorization: Bearer <AMBIGUOUS_AGENT_KEY>` and `API-Version: 1`. The admin key is for provisioning only. Every writer belongs behind `src/ambiguous/client.ts`; the client has a per-attempt timeout, bounded retries, redirect rejection, and metadata-only logs. It does not expose response bodies, request content, recipient addresses, IDs, or keys in errors/logs.

## Verified surface

| Method/path | Scaffold request | Response |
| --- | --- | --- |
| `POST /api/documents` | `{type:"doc",title,content}`; **content is a Markdown string** (`CreateDocumentInput`) | Flat `DocumentEnvelope`, including `id`, `title`, `type`, optional `import_warnings`. No `url` field is promised. |
| `POST /api/tasks` | `{title,description?,assignee_id,status?,due_date?}`; title max 255; assignee is workspace user UUID; due date `YYYY-MM-DD` | `{task: Task}`; client unwraps `task`. |
| `GET /api/tasks/{id}` | Task UUID | `{task: Task}`; client unwraps `task`. |
| `GET /api/tasks/{task_id}/comments` | Optional `limit`, `offset` query parameters | `{data:TaskComment[],total,has_more}`; top-level comments include `replies`. |
| `POST /api/calendars/{calendar_id}/events` | `{title,start_at,end_at,description?,attendees?,meeting_notes_doc_id?}` | Flat `EventResponse` with `id`, `calendar_id`, `start_at`, `end_at`. |
| `POST /api/mail/send` | `{to:string[],subject,body_markdown,in_reply_to?,thread_id?}` and a stable `Idempotency-Key` | Flat `EmailResponse` including `id`, `read`, optional delivery fields. |
| `GET /api/mail/{id}` | Message ID; full response is the default | Flat `EmailResponse`; `from`, `subject`, `body_text`, `body_html`, `thread_id`, `received_at`, and `message_id` are optional/nullable as documented. |
| `GET /api/webhooks/event-types` | No body | `{data:[{type,description}],total,has_more:false}`. |

The client intentionally exposes a small typed subset of each schema; it is not a generated SDK or a complete runtime schema validator. Callers must validate identity and approval evidence before changing records. `renderDoc(markdown)` preserves Markdown as a string. The official recipe verifies the human document link as `<AMBIGUOUS_BASE>/docs/<id>`; `client.documentUrl(id)` constructs that path. Open the first real doc during the spike and verify Alex can view it; default visibility must not be assumed to grant reviewer access.

Only GET requests and mail sends with the same idempotency key retry transport errors, 429, and 5xx. Mail retry keys are scoped to sender and mailbox; reuse with different parameters returns 409. Persist the key with the action before dispatch. A document, task, or calendar POST failure can mean the write succeeded remotely: reconcile manually before another attempt. No idempotency contract exists for those writes in this snapshot. A successful HTTP response whose body cannot be decoded is also treated as ambiguous, without replay. Retry-After is honored up to 30 seconds; a longer interval fails back to the caller.

## Webhooks: confirmed and still pending

OpenAPI registration uses `POST /api/webhooks` with `{url,events,description?}` and returns a signing `secret` once. The event list has **no OpenAPI enum**; the event discovery endpoint above is the closest authoritative source. The official recipe registers `task.assigned`, `email.received`, and `document.shared`. Task completion support remains unconfirmed; poll every three seconds through the same approval handler until the live list proves a usable event exists.

OpenAPI does not describe signing, but the official receiver recipe does:

- `x-webhook-timestamp`: Unix seconds, signed exactly as transmitted.
- `x-webhook-signature`: SHA-256 hex digest, optionally prefixed `sha256=`.
- HMAC-SHA256 using the returned secret over timestamp, a period, and the raw UTF-8 request body.
- Check freshness within five minutes in either direction and compare signatures in constant time. Validate decimal timestamp and 64-hex signature syntax before decoding; the recipe's permissive `parseInt` is insufficient for strict validation.
- The example parses `{event,data}`. This is an envelope example, not an event-specific payload schema.

**TODO during the joint spike:** read the authenticated event list, capture a real `email.received` payload and headers with secrets removed, confirm the email ID location and delivery identity, then check in a sanitized payload for an integration contract test. The current OpenAPI `WebhookDelivery.payload` is only an arbitrary object. Closest endpoints: `GET /api/webhooks/{id}/deliveries`, `POST /api/webhooks/{id}/test`, and `GET /api/mail/{id}`. Do not invent `data.email_id`, trust email body text to identify a principal, or claim a synthetic fixture proves real delivery support.

## Approval and integrated runtime

`Task.status` is `todo | in_progress | done | cancelled | blocked`. `completed_at` is populated for **both done and cancelled**, and no completion actor is exposed on the task. Assignment or completion alone is not proof of human approval. Comments provide `author.id`, `author.primary_email`, `content`, `created_at`, `updated_at`, and nested `replies`. Use the configured approver ID, explicit approval comment, task ID, and timestamps; do not infer authorship from prose. Pagination must be exhausted before concluding no approval exists. Closest additional evidence endpoint: `GET /api/tasks/{id}/activity`.

Both owners still need to validate the complete live loop using the two distinct accounts: webhook receipt, doc readability, task assignment, explicit approval from the designated human, a calendar window with configured times, and final mail delivery. Resolve a real calendar ID through `GET /api/calendars`; do not invent a default ID. Validate mail sender identity from authenticated workspace metadata: `MailParticipant.id` may be the empty string for external addresses. The enabled runtime makes real document/task/calendar/mail calls. Development tests inject mocked services and smoke is local-only. Provisioning and webhook registration are not performed automatically. No code executes a cloud grant.

The runtime polls exact task IDs every three seconds, exhausts comment pagination, and requires the configured author ID, assignment, task binding, durable comment ID, valid timestamp and unedited explicit approval. Delivery/email ID locations require explicit configuration from a real payload. Calendar write intents and mail retry progress are persisted; see [handoff recovery](handoff.md#recovery-and-operating-limits).

## Live verification: 2026-09-12

Live task comments use rich text: Alex's fresh approval arrived as `<p>Approve</p>`, with matching creation/update timestamps and the configured human author ID. The approval parser accepts only one attribute-free paragraph containing an existing explicit approval phrase; nested markup, quotes, entities, multiple paragraphs and attributes remain rejected. The original comment is retained in the decision record. After this compatibility fix, the live record reached `approved`, and both calendar creation and closing email succeeded. Integrated verification passed 75 tests and the offline smoke check.

A real signed webhook ping and a real email sent from the configured human to Reeve both reached the temporary local receiver through HTTPS, with HMAC/freshness validation and HTTP 200. The observed root has `id`, `type`, `timestamp`, `resourceId`, `resourceType`, `resourceUrl`, `summary`, `actor`, `data`, and `workspaceId`. The email event is `email.received`; its `resourceId` is accepted by `GET /api/mail/{id}`. Its actor is `system`, so actor prose/metadata is not used as requester identity. The fetched mail's `from.id` and `from.email` match the configured human.

The live response supplies `body_markdown` and `body_html`; `body_text` is absent. The current OpenAPI projection still lists `body_text`. The client now allows the observed additive `body_markdown` field, and normalization uses fetched `body_text` or `body_markdown`, never rendering the HTML. Webhook previews and sender claims remain untrusted.

Configure `WEBHOOK_EVENT_TYPE_PATH=type`, `WEBHOOK_DELIVERY_ID_PATH=id`, and `WEBHOOK_EMAIL_ID_PATH=resourceId`. All paths are root-relative. In configured mode the internal intake record retains the entire original provider envelope in `data`; this preserves root-level evidence for the worker. Legacy injectable tests can still use the original `{event,data}` seam. A redacted real-shaped fixture covers the new boundary.

The authenticated event list also includes `task.completed`; the runtime retains its existing non-overlapping poll because completion alone does not prove attributable approval. Live mail intake evidence does not by itself establish document visibility, approval, calendar or closing mail acceptance.
