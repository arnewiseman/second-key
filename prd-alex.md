# Second Key: Alex implementation plan

This document defines Alex's implementation plan for the workspace loop. It preserves the frozen contracts in `prd.MD` and adds the interfaces, invariants, phases, and verification gates needed to complete the loop.

## 1. Scope

Alex owns the path from a verified Ambiguous webhook to a durable decision record and the external workspace actions that follow.

Alex owns these paths:

- `src/server.ts`
- `src/webhook.ts`
- `src/router.ts`
- `src/ambiguous/*`
- `src/record/*`
- Loop tests
- `fixtures/webhooks/*`

Arne owns the analysis engine, policy rules, IAM fixtures, inbound fixtures, and engine tests. Both owners must agree before changing `src/types.ts`, `src/ports.ts`, configuration, or package dependencies.

## 2. Product outcome

The service receives an access request by email. It verifies the delivery, identifies the trusted sender, asks the analysis engine for an `Analysis`, and stores a `DecisionRecord`.

For an accepted analysis, the service creates an analysis document and an approval task for a different human. After that human adds an attributable approval comment, the service creates the agreed calendar event, emails the requester, and records each state change.

For a refused analysis, the service sends a refusal email, creates no approval task, and stores the refusal and its rule IDs in the record.

The service never calls a cloud provider and never executes an access grant.

## 3. Current contracts to preserve

The frozen analysis seam is:

```ts
type Analyze = (inbound: { text: string; from: Principal }) => Promise<Analysis>;
```

The current internal workspace port is:

```ts
interface Workspace {
  createDocument(doc: { title: string; content: string }): Promise<{ url: string }>;
  createApprovalTask(task: {
    title: string;
    docUrl: string;
    approver: Principal;
  }): Promise<{ id: string }>;
  sendRefusal(mail: {
    to: Principal;
    reason: string;
    recordId: string;
  }): Promise<void>;
}
```

The workspace port is an internal contract. It must not expose Ambiguous API payloads to the router.

The current `DecisionRecord` remains the record format. Every enrichment appends one event. The original analysis and creation time remain immutable.

## 4. Data contracts and touch points

### 4.1 Verified webhook delivery

The server accepts a raw HTTP request and produces a verified envelope.

```ts
type VerifiedWebhook = {
  deliveryId: string;
  event: string;
  data: unknown;
  receivedAt: string;
};
```

Contract rules:

- Verify the HMAC over the original raw bytes before parsing JSON.
- Reject a missing, malformed, or older-than-five-minute timestamp with `401`.
- Reject an invalid event envelope with `400`.
- Reject a body larger than the configured limit with `413`.
- Use the provider delivery ID for deduplication when the live event supplies one.
- Do not use the request body hash as a substitute for a provider delivery ID unless the real event has no ID and both owners agree.
- Do not pass `data` directly to the router.

Touch points:

```text
HTTP request
  -> verifyWebhook(raw bytes)
  -> parseEnvelope(raw bytes)
  -> normalizeWebhook(envelope)
  -> persist intake job
  -> return 200
```

### 4.2 Normalized email event

The normalizer converts the provider event into trusted application input.

```ts
type NormalizedEmail = {
  deliveryId: string;
  emailId: string;
  text: string;
  from: Principal;
  receivedAt: string;
  threadId: string | null;
  messageId: string | null;
};
```

Contract rules:

- Resolve the sender from the provider email record or a trusted event field.
- Never obtain `Principal` identity from model output or free-text email content.
- Require a user principal for the requester unless the verified event identifies another supported principal type.
- Preserve the provider email ID for logs, deduplication, and reply threading.
- Reject an event that lacks trusted sender identity or usable text. Store the rejection reason.

### 4.3 Intake job

The webhook handler persists a small job before it returns success.

```ts
type IntakeJob = {
  id: string;
  deliveryId: string;
  event: string;
  data: unknown;
  receivedAt: string;
  state: "queued" | "processing" | "complete" | "failed";
  attempts: number;
  lastError: string | null;
};
```

Contract rules:

- A repeated `deliveryId` does not create a second record or repeat an external write.
- The HTTP handler does not run the model, fetch email details, or make workspace writes.
- The worker normalizes `data` into `NormalizedEmail` before it calls `Analyze`.
- A worker can resume `queued` and `processing` jobs after restart.
- One worker processes one logical request at a time.
- The job ID and delivery ID appear in structured logs without secrets or raw message content.

### 4.4 Analysis input and output

The worker calls the frozen `Analyze` function with:

```ts
{ text: email.text, from: email.from }
```

The worker must retain the `Analysis` returned by the engine without rewriting its findings, recommendation, refusal, or decision sentence.

The router creates the record ID. The engine request ID inside `AccessRequest.id` remains part of the analysis. If the two IDs differ, the record stores both through existing fields or an agreed shared-contract change.

### 4.5 Workspace writes

The router uses the internal `Workspace` port. The adapter maps each operation to the verified Ambiguous client.

```text
Analysis
  -> renderAnalysisDoc()
  -> Workspace.createDocument()
  -> document URL
  -> Workspace.createApprovalTask()
  -> task ID
```

The adapter must:

- Use the document content shape defined by the verified API contract.
- Build document URLs with `AmbiguousClient.documentUrl()`.
- Assign the task to the configured approver.
- Include the document URL in the task description.
- Avoid automatic retries for non-idempotent document and task creation.
- Treat an uncertain successful response as an ambiguous outcome that needs reconciliation before replay.

### 4.6 Approval evidence

Approval is a separate contract. A task status alone does not prove approval.

```ts
type ApprovalEvidence = {
  recordId: string;
  taskId: string;
  taskStatus: TaskStatus;
  commentId: string;
  comment: string;
  actor: Principal;
  approvedAt: string;
};
```

Accept approval only when all conditions hold:

- The task ID belongs to the decision record.
- The task is assigned to the configured approver.
- The comment author matches the configured approver by trusted ID or verified email.
- The comment contains an explicit approval decision according to the agreed parser.
- The task does not show cancellation or a conflicting state.
- The requester and approver are different principals.

Do not treat these as approval:

- The requester claims that approval happened elsewhere.
- A task has `completed_at` without an attributable comment.
- A comment from an untrusted or different actor exists.
- A task is merely assigned or marked `done`.

### 4.7 Closeout

After approval evidence passes validation, the closeout operation uses the recommendation and approved scope from the record.

```ts
type CloseoutInput = {
  recordId: string;
  approval: ApprovalEvidence;
  calendarId: string;
  changeWindow: { startAt: string; endAt: string };
};
```

Closeout writes occur in this order:

1. Create the calendar event.
2. Append the calendar event ID and approval evidence to the record.
3. Send the requester email with the approved scope and expiry.
4. Append the mail ID to the record.
5. Set `state` to `approved` and append the final event.

Each external side effect must have a recorded recovery state. Mail uses a stable idempotency key. Calendar and task/document writes require reconciliation before replay because the verified API contract does not provide a confirmed idempotency key.

The closeout path must not claim that an IAM grant occurred.

## 5. Phases of work

Track progress in this document. Mark a task complete only when its code, test, or live evidence exists. Update the phase status when all required tasks reach their exit criteria.

Status values:

- `Not started`: no implementation work is complete.
- `In progress`: at least one task is complete, but the exit criteria are not met.
- `Blocked`: work needs an external decision, credential, or environment change.
- `Complete`: all exit criteria are verified.

### Phase 0: confirm the external contract

Status: `In progress`

Goal: remove unknowns before wiring business logic.

Tasks:

- [x] Read `docs/ambiguous-api.md` and review the checked OpenAPI contract.
- [ ] Fetch the official OpenAPI document during the live integration spike.
- [ ] Call the event-types endpoint and record the actual event names.
- [ ] Capture one real, redacted `email.received` delivery.
- [ ] Confirm the delivery ID, sender field, email ID, thread ID, and task comment shape.
- [ ] Create one real document and verify that the configured approver can open it.
- [ ] Confirm the calendar ID and the two human identities.

Exit criteria:

- `fixtures/webhooks/email.received.json` contains a redacted synthetic shape based on a real delivery.
- The sender mapping and event normalization fields are documented.
- No unverified endpoint or event field appears in implementation code.

### Phase 1: finish intake security and normalization

Status: `In progress`

Goal: accept only authenticated, bounded, normalized events.

Tasks:

- [x] Keep raw-body HMAC verification before JSON parsing.
- [x] Add verified delivery identity and event normalization as a standalone normalizer.
- [ ] Add explicit payload, timestamp, event, and sender errors.
- [ ] Add tests for valid delivery, bad signature, stale timestamp, malformed envelope, oversized body, and missing sender.

Exit criteria:

- Valid events produce `NormalizedEmail`.
- Invalid events produce the correct HTTP status.
- No router call occurs for invalid input.

### Phase 2: add durable intake and worker recovery

Status: `In progress`

Goal: return from the webhook quickly without losing accepted work.

Tasks:

- [x] Persist `IntakeJob` before returning `200`.
- [x] Deduplicate by provider delivery ID.
- [ ] Recover queued and processing jobs on startup.
- [ ] Serialize processing by decision or email identity.
- [ ] Bound the queue and record rejected capacity.
- [ ] Stop polling and worker timers on shutdown.

Exit criteria:

- The webhook returns within two seconds without calling the model.
- A repeated delivery produces no duplicate record or external write.
- A process restart resumes an incomplete job.

### Phase 3: complete accepted and refused routing

Status: `In progress`

Goal: connect the worker to the router and workspace adapter.

Tasks:

- [ ] Replace scaffold status values in `/health` when the loop is wired.
- [x] Build the document, task, and refusal portions of the `Workspace` adapter over `AmbiguousClient`.
- [ ] Store the initial record before external writes.
- [ ] Create the analysis document and approval task for accepted analyses.
- [ ] Send refusal email and create no task for refused analyses.
- [ ] Persist every record update with an appended event.

Exit criteria:

- Fixture 01 creates one document, one task, and an `awaiting_approval` record.
- Fixture 02 creates no task and reaches `refused`.
- External errors leave a recoverable record with the last completed side effect.

### Phase 4: implement approval detection

Status: `In progress`

Goal: accept only attributable approval for the exact record.

Tasks:

- [ ] Confirm whether task completion has a webhook event.
- [ ] Implement the webhook handler if available.
- [ ] Otherwise poll outstanding task IDs every three seconds.
- [ ] Fetch task comments and identify the configured approver's explicit decision.
- [x] Ignore cancelled tasks, untrusted comments, and requester claims in the evidence parser.
- [ ] Make repeated approval deliveries safe.

Exit criteria:

- The same record cannot close from an unrelated task.
- A completion without an approver comment does not close the record.
- The approval event stores actor, timestamp, comment, and task ID.

### Phase 5: close the approved request

Status: `Not started`

Goal: complete the workspace loop without executing access.

Tasks:

- [ ] Create the approved change-window calendar event.
- [ ] Email the requester with approved scope and expiry.
- [ ] Use a stable mail idempotency key.
- [ ] Record each external result and failure.
- [ ] Set the final state to `approved` only after required side effects succeed.
- [ ] Add tests for partial calendar success, mail retry, duplicate approval, and recovery.

Exit criteria:

- The record reconstructs the full chain from email through approval and closeout.
- The requester receives the exact approved scope and expiry.
- No code path calls a cloud provider or grants IAM access.

### Phase 6: integrated verification

Status: `In progress`

Goal: verify the six demo shots with separate requester and approver accounts.

Tasks:

- [x] Run `npm run check`.
- [x] Run `npm run smoke` and label its output as offline evidence.
- [ ] Verify one live intake, document, approval task, approval comment, calendar event, closing email, and record.
- [ ] Verify the refusal path with fixture 02.
- [ ] Run repeated deliveries and restart recovery tests.
- [ ] Attempt expiry only after the core loop passes.

Exit criteria:

- The core loop passes with separate accounts.
- Offline stub evidence and live acceptance evidence remain clearly separated.
- The README describes the implemented boundary accurately.

### 5.1 Work item registry

Use these IDs in implementation notes, test names, and progress updates. Each item has one primary output and one verification target.

| ID | Work item | Primary files | Verification |
| --- | --- | --- | --- |
| ALEX-00 | Confirm the live webhook and workspace contract | `docs/ambiguous-api.md`, `fixtures/webhooks/*` | Redacted live payload and contract notes |
| ALEX-01 | Normalize verified webhook envelopes | `src/webhook.ts`, `src/server.ts` | Webhook and normalization tests |
| ALEX-02 | Resolve trusted email identity and content | `src/router.ts`, `src/ambiguous/client.ts` | Sender, email lookup, and rejection tests |
| ALEX-03 | Persist and deduplicate intake jobs | `src/record/*`, `src/server.ts` | Duplicate delivery and atomic-write tests |
| ALEX-04 | Recover jobs and serialize processing | `src/server.ts`, `src/router.ts` | Restart, concurrent-delivery, and shutdown tests |
| ALEX-05 | Map the workspace port to Ambiguous | `src/ambiguous/*` | Request-shape and response-mapping tests |
| ALEX-06 | Route accepted and refused analyses | `src/router.ts`, `src/record/*` | Fixture 01 and fixture 02 router tests |
| ALEX-07 | Detect attributable approvals | `src/router.ts`, `src/ambiguous/client.ts` | Comment-author, parser, pagination, and cancellation tests |
| ALEX-08 | Persist external-effect recovery state | `src/record/*` | Partial-write and reconciliation tests |
| ALEX-09 | Close approved requests | `src/router.ts`, `src/ambiguous/*` | Calendar, mail, expiry, and duplicate-approval tests |
| ALEX-10 | Run integrated acceptance | `test/*`, `README.md` | `npm run check`, `npm run smoke`, live six-shot run |

### 5.2 Work item details

#### ALEX-00: confirm the live contract

Dependencies: provider credentials, two workspace accounts, tunnel, and webhook secret.

Tasks:

- [ ] Record the OpenAPI revision used for implementation.
- [ ] Record the event types returned by `GET /api/webhooks/event-types`.
- [ ] Capture the raw authenticated delivery before parsing it.
- [ ] Remove secrets, credentials, and private message content from the checked-in fixture.
- [ ] Document the delivery ID, email ID, sender, body, thread, and message fields.
- [ ] Verify document visibility as the approver.
- [ ] Resolve and record the real calendar ID.

Output: a sanitized webhook fixture and an updated contract note.

#### ALEX-01: normalize verified webhook envelopes

Dependencies: ALEX-00 for the event payload shape. Use the synthetic envelope for offline tests before the live payload is available.

Tasks:

- [x] Keep HMAC verification over raw bytes.
- [x] Validate the timestamp and signature before JSON parsing.
- [ ] Validate event name, delivery identity, and payload size at the HTTP boundary.
- [ ] Return `401`, `400`, and `413` for the documented failure classes.
- [x] Convert supported email events to `NormalizedEmail`.
- [x] Reject unsupported events without calling the router.

Output: a typed normalizer with deterministic errors.

#### ALEX-02: resolve trusted identity and content

Dependencies: ALEX-00 and the verified `AmbiguousClient.getEmail()` contract.

Tasks:

- [x] Map the provider sender to a configured `Principal` through the resolver seam.
- [x] Reject missing, empty, or untrusted sender identity.
- [x] Use event content when the event includes a complete email.
- [x] Fetch the email when the event includes only an email ID.
- [x] Preserve email ID, thread ID, and message ID for routing and replies.
- [x] Keep model output out of identity resolution.

Output: one normalized application input for every supported email event. The HTTP intake does not call this normalizer yet.

#### ALEX-03: persist and deduplicate intake

Dependencies: ALEX-01 and the existing atomic JSON store.

Tasks:

- [x] Define the persisted `IntakeJob` file shape.
- [x] Write the job before returning `200`.
- [x] Use the provider delivery ID as the primary deduplication key.
- [x] Return success for a duplicate already accepted by the system.
- [x] Preserve the first payload and received timestamp.
- [x] Record failed normalization without creating a decision record.

Output: durable intake storage with repeat-delivery safety.

#### ALEX-04: recover and serialize processing

Dependencies: ALEX-03.

Tasks:

- [x] Load queued and processing jobs on startup.
- [x] Reset or resume interrupted jobs according to their last durable state.
- [x] Serialize processing for one delivery.
- [ ] Bound the in-memory work queue.
- [ ] Prevent overlapping approval polls.
- [ ] Stop workers and timers during shutdown.
- [ ] Keep the webhook acknowledgment path independent from worker completion.

Output: a single-process worker with restart recovery.

#### ALEX-05: map the workspace adapter

Dependencies: ALEX-00 and the verified client methods.

Tasks:

- [x] Map Markdown content to `POST /api/documents`.
- [x] Build the document URL from the returned document ID.
- [x] Map the approval task title, description, and approver ID.
- [x] Map refusal mail to the requester address and record ID.
- [ ] Add calendar and closeout methods behind the internal workspace boundary.
- [x] Keep provider response types inside `src/ambiguous/*`.
- [x] Do not retry document, task, or calendar creation blindly.

Output: an adapter that exposes only internal application operations.

#### ALEX-06: route accepted and refused analyses

Dependencies: ALEX-02 through ALEX-05 and Arne's `Analyze` implementation or the fixture stub.

Tasks:

- [ ] Check requester and approver separation before workspace writes.
- [ ] Save the initial record before creating external artifacts.
- [ ] Render and create the analysis document.
- [ ] Create the approval task with the document link.
- [ ] Set accepted records to `awaiting_approval`.
- [ ] Send the refusal email with every blocking rule ID.
- [ ] Create no task for refused analyses.
- [ ] Append one audit event for each state or side-effect transition.

Output: accepted and refused routing with durable audit history.

#### ALEX-07: detect attributable approvals

Dependencies: ALEX-06 and ALEX-00 event discovery.

Tasks:

- [ ] Select polling or webhook handling from the confirmed event list.
- [ ] Fetch the task and all comment pages.
- [x] Match task ID and configured assignee to the decision record.
- [x] Match comment author by trusted ID or verified email.
- [x] Parse only explicit positive approval language.
- [x] Reject cancellation, negation, requester claims, and unrelated comments.
- [x] Store comment text, actor, timestamp, and task ID.
- [ ] Make repeated approval evidence a no-op.

Output: approval evidence that can support closeout.

#### ALEX-08: persist external-effect recovery state

Dependencies: ALEX-03 and ALEX-05.

Tasks:

- [ ] Add an Alex-owned sidecar keyed by decision record ID.
- [ ] Persist `pending` before each external write.
- [ ] Persist provider IDs after successful responses.
- [ ] Persist `ambiguous` when a non-idempotent result cannot be confirmed.
- [ ] Persist the stable mail idempotency key before sending mail.
- [ ] Append a matching human-readable record event.
- [ ] Add reconciliation lookup paths before replay.

Output: recoverable side-effect state without changing frozen shared types.

#### ALEX-09: close approved requests

Dependencies: ALEX-07 and ALEX-08.

Tasks:

- [ ] Require a configured calendar ID and valid change window.
- [ ] Create the calendar event with approved scope and document context.
- [ ] Persist the calendar result before sending mail.
- [ ] Send the requester scope and expiry with stable idempotency.
- [ ] Persist the mail result before final state transition.
- [ ] Set the record to `approved` only after required effects succeed.
- [ ] Preserve a recovery state when a later effect fails.
- [ ] Prevent duplicate closeout from repeated approvals.

Output: a complete, recoverable approval closeout.

#### ALEX-10: integrated acceptance

Dependencies: ALEX-00 through ALEX-09 and Arne's engine work.

Tasks:

- [x] Install dependencies with `npm ci`.
- [x] Run `npm run check`.
- [x] Run `npm run smoke` and label it offline evidence.
- [ ] Run the happy path with separate requester and approver accounts.
- [ ] Run the refusal path and verify no task exists.
- [ ] Repeat the same webhook delivery.
- [ ] Restart during queued and processing states.
- [ ] Verify document, task, approval comment, calendar event, email, and record.
- [ ] Update the README to match observed behavior.

Output: live acceptance evidence for the core loop.

### 5.3 Dependency order

The implementation follows this order:

```text
ALEX-00
  -> ALEX-01 -> ALEX-02 -> ALEX-03 -> ALEX-04
                                  -> ALEX-05 -> ALEX-06 -> ALEX-07
                                                     -> ALEX-08 -> ALEX-09 -> ALEX-10
```

ALEX-01 and ALEX-05 can proceed in parallel after the documented contract review. ALEX-03 can use the synthetic webhook fixture while ALEX-00 waits for live credentials. ALEX-07 must not claim completion until the approval evidence rules pass unit tests and the live task/comment shape is verified.

## 6. Failure and retry policy

The system distinguishes three outcomes:

| Outcome | Meaning | Action |
| --- | --- | --- |
| Rejected | The request fails validation or authentication | Return a client error. Do not enqueue. |
| Failed before external write | Local processing fails | Keep the job and record retry metadata. |
| Ambiguous external result | A write may have succeeded but the response is unknown | Reconcile by provider ID or verified lookup. Do not blindly replay. |

The client retries safe `GET` requests and mail requests with a stable idempotency key. It does not blindly retry document, task, or calendar creation.

## 7. Testing matrix

| Area | Required evidence |
| --- | --- |
| Webhook security | Valid HMAC, invalid HMAC, stale timestamp, malformed JSON, oversized body |
| Intake | Fast acknowledgment, delivery deduplication, restart recovery, queue bound |
| Identity | Trusted sender mapping, requester/approver separation, unknown sender rejection |
| Routing | Accepted analysis, refused analysis, no task on refusal |
| Workspace | Document visibility, task assignment, linked document, refusal email |
| Approval | Correct task, correct actor, explicit comment, cancelled task rejection |
| Closeout | Calendar write, scoped email, expiry, audit events, duplicate approval safety |
| Integration | `npm run check`, `npm run smoke`, live six-shot demo |

## 8. Decisions and remaining verification

The documented API contract in [`docs/ambiguous-api.md`](docs/ambiguous-api.md) resolves most implementation choices. The live integration spike must verify the event-specific fields that the OpenAPI specification does not define.

### 8.1 Webhook delivery identity

Decision: use the provider's delivery ID as `deliveryId` and make it the intake deduplication key.

The OpenAPI specification does not define the event payload field. The event envelope contains an arbitrary `data` object. During the integration spike, capture one authenticated `email.received` delivery and record the exact field that identifies the delivery. Do not invent a field such as `data.email_id`. If the provider does not supply a delivery ID, agree on a stable fallback before implementation. A body hash is acceptable only as an explicitly documented fallback.

### 8.2 Trusted sender identity

Decision: resolve the sender from authenticated mail metadata, not from the model or message prose.

Use the sender fields returned by the real event or by `GET /api/mail/{id}`. The client exposes `MailParticipant.email` and optional `MailParticipant.id`. Treat `MailParticipant.id === ""` as missing identity. Reject the event when the service cannot map the sender to a trusted `Principal`.

The exact event field remains a live-spike item because the webhook payload schema is not defined by OpenAPI.

### 8.3 Email content retrieval

Decision: support both event shapes behind one normalizer.

- If the event includes the full email, normalize its trusted sender, body, email ID, thread ID, and message ID directly.
- If the event includes only an email ID, call `GET /api/mail/{id}` through `AmbiguousClient.getEmail()`.
- If the event lacks both usable body content and an email ID, reject the event and record the reason.

Do not route the raw webhook `data` object into `Analyze`.

### 8.4 Task completion events

Decision: poll until the live event list proves that a usable task-completion event exists.

Call `GET /api/webhooks/event-types` during the integration spike. The official recipe confirms `task.assigned`, `email.received`, and `document.shared`. Task completion remains unconfirmed. Until a usable event appears, poll outstanding task IDs every three seconds through the same approval handler. Stop the timer on shutdown. Do not treat `completed_at` as approval because it also appears on cancelled tasks and exposes no completion actor.

### 8.5 Explicit approval comments

Decision: require a positive approval comment from the configured approver for the exact task.

The first implementation accepts a comment after trimming and case-folding when it contains an explicit positive decision such as `approve`, `approved`, `I approve`, or `approved with the proposed scope`. The parser rejects comments containing negation or refusal terms such as `do not approve`, `not approved`, `reject`, `deny`, or `cancel`. The parser does not infer approval from task status, requester claims, or quoted text from another person.

The approval handler must also verify:

- The task ID matches the record.
- The task assignee matches the configured approver.
- The comment author matches the configured approver by trusted ID or verified email.
- Pagination is exhausted before the handler concludes that no approval exists.
- The task is not cancelled.

Keep this parser narrow. Add test cases before accepting additional wording.

### 8.6 Calendar change-window duration

Decision: do not infer a duration from the email. Require an explicitly configured change window.

Use a configured calendar ID and either configured start and end timestamps or a configured duration. For the demo, use a 60-minute window only when the operator provides that value through configuration. If no valid window exists, keep the record awaiting closeout and report the missing configuration. Do not create a calendar event with an invented time.

The calendar endpoint is `POST /api/calendars/{calendar_id}/events`. Resolve the real calendar ID through the verified calendar listing before live acceptance. Do not assume a default calendar ID.

### 8.7 Recovery identifiers for external writes

Decision: record provider identifiers in an Alex-owned sidecar, then append a human-readable audit event to `DecisionRecord.events`.

The verified response fields are:

| Operation | Recovery fields |
| --- | --- |
| Document | `id`, `title`, `type`, optional `import_warnings` |
| Approval task | `id`, `status`, `assignee_id`, `completed_at` |
| Calendar event | `id`, `calendar_id`, `start_at`, `end_at` |
| Mail | `id`, optional `message_id`, `thread_id`, `delivery_status` |

Create an Alex-owned sidecar record keyed by `DecisionRecord.id`:

```ts
type ExternalEffect = {
  recordId: string;
  operation: "document" | "task" | "calendar" | "mail";
  state: "pending" | "succeeded" | "ambiguous" | "failed";
  providerId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
};
```

The sidecar supports reconciliation without changing the frozen `DecisionRecord` type. The record event states what happened and points to the provider ID. The sidecar stores the exact recovery state and mail idempotency key.

### 8.8 Retry and idempotency decisions

Decision: retry only operations with a verified safe retry contract.

- Retry `GET` requests.
- Retry mail sends with the same stable `Idempotency-Key` and identical parameters.
- Do not blindly retry document, task, or calendar creation.
- Mark uncertain non-idempotent results as `ambiguous` and reconcile them before replay.
- Treat a successful response with an undecodable body as ambiguous.

Mail idempotency keys must be persisted before dispatch and must remain stable for the same record and operation. Reusing a key with different parameters can return `409`.

### 8.9 Final live-spike checklist

The following items remain open until the two-account integration spike completes:

- Confirm the exact webhook delivery ID field.
- Confirm the exact sender field and trusted principal mapping.
- Confirm whether the event includes full email content or requires `getEmail()`.
- Confirm the live task event list.
- Open a real document as the approver and verify visibility.
- Resolve a real calendar ID.
- Verify the configured sender identity and mail delivery.

If any answer requires a shared type change, stop at the boundary and agree with Arne before editing `src/types.ts` or `src/ports.ts`.

## 9. Definition of done

The Alex implementation is complete when a verified email creates one durable request flow, the correct human approves it with an attributable comment, the service creates the calendar and email side effects, and the record reconstructs every state change.

The implementation passes `npm run check` and `npm run smoke`. Live acceptance evidence identifies which steps use the real Ambiguous workspace. The service makes no IAM grant and no cloud-provider call.
