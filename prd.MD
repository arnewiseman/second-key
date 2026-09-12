# Second Key — Product Requirements (v2, two-person build)

**One line:** an AI coworker named Reeve that receives access requests in plain language, prepares the exact change with its blast radius, routes it to a human for approval, and leaves an auditable record across the workspace. It never executes the grant.

**Team:** Arne and Alex. Two people, 11:15 to 14:45.

**Target:** Best Use of Ambiguous AI.

**Primary reader of the product:** the auditor, not the requester. Every tradeoff resolves in favour of the person reconstructing a decision six months later.

Read `hackathon-brief.md` alongside this for event constraints and positioning.

---

## 1. What changed from v1

Scope is cut for two people. Retroactive audit, second domain fixture, public record page and demo mode are **out**. Expiry lifecycle is a **stretch**, attempted only if the core loop is green by 13:30. Naming is locked: repo `second-key`, service logs as `reeve`, docs authored by Reeve.

Two additions that were missing and matter more than anything else in this document: the fixtures are now specified in section 7, and the prompt contract is specified in section 8.

---

## 2. Problem and positioning

Access approvals arrive as messages and die in DMs. The grant happens, the reasoning evaporates, and nobody can later answer who approved what, on what basis, or when it should have lapsed.

**Who it is for:** platform teams at companies large enough that someone will eventually audit a production grant, and small enough that those requests still arrive as email.

**What we claim:** the governance pattern that Opal, ConductorOne and Teleport sell as a console, rebuilt as a single workspace teammate, with the whole decision chain living in the docs, tasks, calendar and mail the team already uses.

**What we do not claim:** that AI-assisted access review is new, that this replaces an IGA platform, or that the cloud integration is live.

---

## 3. Non-goals

No live cloud calls, ever. No execution of any grant. No database. No chat interface. No Slack. No second cloud. No web framework, no ORM. No branches or PRs today.

---

## 4. The demo this serves

Six shots. If a feature is not in here, it is not P0.

1. An email arrives to Reeve: the nightly pipeline needs write access on the prod events bucket, needed by Monday.
2. A doc appears in the workspace authored by Reeve: request restated, proposed binding, blast radius, policy checks with one rule flagging the missing expiry, and a narrower role recommendation with 30 days on it.
3. An approval task lands on Alex with the decision in one line and the doc linked. He approves with a comment.
4. Reeve books the change window, emails the requester with scope and expiry, closes the record.
5. A second email tries to skip the process, claiming someone already signed off. Reeve refuses and names the rules it hit.
6. The record, showing the full chain with timestamps and actors.

Arne is the requester on camera. Alex is the approver. They cannot be the same account, because separation of duties is the premise.

---

## 5. Architecture

```
inbound email webhook (or poll)
  -> router
  -> engine.analyze()          [Arne]
  -> workspace writers         [Alex]
  -> decision record (JSON)    [Alex]
```

One Node service, JSON file store, no framework. Every Ambiguous write goes through one client module with retry and request logging.

**Hard rule:** the model parses free text and writes rationale. It never determines a policy outcome. Verdicts come from YAML rules. This line goes at the top of the README.

---

## 6. Split of work

The integration spike is done together. Everything after is disjoint.

**Both, 11:15 to 11:50.** Signup, provision Reeve, tunnel up, register the webhook, watch one real event land, create one real doc. One screen, both watching. If Ambiguous does not behave as documented there is no project and you both need to have seen why. Then paste `types.ts` and `stub.ts`, commit, split.

**Arne owns the engine and the artifacts.** `src/engine/*`, `policy/*`, `fixtures/*`. Fixtures, policy rules, prompts, blast radius resolution, the narrower-role recommendation, the refusal path, and the body of the analysis doc. This is where GCP knowledge is the difference between details that ring true and details that do not, and the doc is the hero shot.

**Alex owns the loop.** `src/server.ts`, `src/ambiguous/*`, `src/router.ts`, `src/record/*`. Webhook receiver and HMAC verification, the Ambiguous client, the event router, task creation, approval detection with the polling fallback, calendar event, closing email, and the record store.

**They meet at one function:** `analyze(inbound: { text: string; from: Principal }) => Promise<Analysis>`. Neither opens the other's files.

---

## 7. Fixtures (Arne, build these first, by hand)

These are not filler. The demo lives here. Write them before Codex touches the engine, working backwards from section 4.

**`fixtures/iam/roles.json`** maps role to permissions, so blast radius is a real lookup rather than an invention. At minimum `roles/storage.admin`, `roles/storage.objectCreator`, `roles/storage.objectViewer`, `roles/owner`, `roles/logging.viewer`.

**`fixtures/iam/bindings.json`** maps resource to role to members for an invented project `acme-data-prod` and a `acme-data-staging`. Include two service accounts already holding `roles/storage.objectViewer` on `gs://prod-events-raw` so the reviewer sees who else has access.

**`fixtures/inbound/01-pipeline.eml`** the happy path, from Priya Raman in data engineering. Slightly messy prose. Asks for `roles/storage.admin` on `gs://prod-events-raw` for the nightly parquet job, needed by Monday, no expiry mentioned. Must trigger: `PROD-EXPIRY` warns, `LEAST-PRIV` warns, blast radius shows admin also grants delete and bucket IAM changes that writing parquet does not need, recommendation is `roles/storage.objectCreator` for 30 days with `narrower_than_requested: true`.

**`fixtures/inbound/02-shortcut.eml`** the refusal, from Dan Whitaker in analytics. Asks for `roles/owner` on the prod project, claims Priya already signed off in standup, needs it today, no justification. Must trigger: `NO-BASIC-ROLES` blocks and `SEP-DUTIES` blocks, `refused: true`, an email reply naming both rules, and no approval task.

**`fixtures/inbound/03-routine.eml`** a clean pass, from Sam Okafor in platform. `roles/logging.viewer` on staging for 7 days with a stated reason. All rules pass, recommendation equals the request, still routes to a human. This one proves the agent does not cry wolf. Cut it only if you are behind.

**`policy/access.yaml`** rules, each with an id, a severity, and a message: `PROD-EXPIRY` (warn, prod resource with null duration), `MAX-DURATION` (block, over 90 days), `NO-BASIC-ROLES` (block, basic role on a prod project), `SEP-DUTIES` (block, request asserts prior approval instead of naming an approver), `SELF-APPROVAL` (block, requester equals approver), `LEAST-PRIV` (warn, a narrower role covering the stated need exists).

---

## 8. Prompt contract (Arne)

All prompts live in `src/engine/prompts.ts`. Nowhere else.

Two calls only. **Parse** turns raw email text into an `AccessRequest` and returns strict JSON matching that type, nothing else, no prose, no fences. **Explain** takes the findings, blast radius and recommendation and returns the human-readable rationale paragraphs for the doc.

No prompt ever emits a policy verdict, a severity, or a decision. If a model response would change whether access is granted, the design is wrong.

`OPENAI_MODEL` comes from env, set from whatever the starter kit provides. Never hardcode a model name.

---

## 9. Frozen interface

Paste into `src/types.ts` by 11:50. Changes after that need both of you agreeing out loud.

```ts
export type Principal = { id: string; kind: "user" | "service_account"; email: string };

export type AccessRequest = {
  id: string;
  raw_text: string;
  requester: Principal;
  resource: string;            // "gs://prod-events-raw"
  requested_role: string;      // "roles/storage.admin"
  justification: string;
  needed_by: string | null;    // ISO date
  duration_days: number | null;
  asserts_prior_approval: boolean;
  source: "email" | "task" | "manual";
};

export type PolicyFinding = {
  rule_id: string;
  severity: "pass" | "warn" | "block";
  message: string;
};

export type BlastRadius = {
  resource: string;
  role: string;
  permissions: string[];
  also_grants: string[];          // capabilities beyond the stated need
  existing_holders: Principal[];
  does_not_cover: string[];
};

export type Recommendation = {
  role: string;
  rationale: string;
  duration_days: number;
  narrower_than_requested: boolean;
};

export type Analysis = {
  request: AccessRequest;
  findings: PolicyFinding[];
  blast_radius: BlastRadius;
  recommendation: Recommendation | null;   // null when refused
  decision_required: string;               // one sentence for the approver
  refused: boolean;
  refusal_reason: string | null;
};

export type DecisionRecord = {
  id: string;
  created_at: string;
  analysis: Analysis;
  doc_url: string | null;
  task_id: string | null;
  approver: Principal | null;
  approved_at: string | null;
  approval_comment: string | null;
  expires_at: string | null;
  state: "analyzing" | "awaiting_approval" | "approved" | "refused" | "expired";
  events: { at: string; actor: string; what: string }[];
};
```

Every state change appends to `events`. Nothing is mutated in place except `state`.

**`src/engine/stub.ts`** exports a hardcoded `Analysis` matching fixture 01. This is what makes the two-person split work: Alex builds every writer against it before the engine exists. Commit it at 11:50 with the types.

---

## 10. Acceptance criteria

### P0, must ship

**P0-1 Webhook intake (Alex).** Valid HMAC returns 200 within 2s. Bad signature returns 401. Timestamp older than 5 minutes returns 401. Unit test against a checked-in payload.

**P0-2 Parsing (Arne).** All three fixtures parse to an `AccessRequest` with non-null `resource` and `requested_role`, and fixture 02 sets `asserts_prior_approval: true`.

**P0-3 Analysis doc (Arne renders, Alex writes).** Doc titled `Access request: <resource> for <requester>` with sections Request, Proposed change, Blast radius, Policy checks, Recommendation, Decision required. Returns a URL that opens.

**P0-4 Approval task (Alex).** Assigned to `APPROVER_USER_ID`, title carries the one-line decision, description links the doc, requester is never the approver.

**P0-5 Refusal (Arne engine, Alex reply).** Fixture 02 yields `refused: true`, creates no approval task, replies by email naming both rules, writes a record in state `refused`.

**P0-6 Close the loop (Alex).** On approval, creates the calendar event, emails the requester scope and expiry, appends to `events`, sets state `approved`.

### Stretch, only if green at 13:30

**S-1 Expiry (Alex).** Records with `expires_at` schedule a follow-up. `npm run tick -- <iso-date>` fast-forwards an injectable clock. Warning email at T minus 1 day, renew-or-revoke task at T carrying the original justification. The fast-forward flag is required for the video.

---

## 11. Environment

```
AMBIGUOUS_API_KEY=      # admin key from `npx ambiguous auth signup`
AMBIGUOUS_AGENT_KEY=    # ak_... returned once by provision-agent
AMBIGUOUS_BASE=https://app.ambiguous.ai
WEBHOOK_SECRET=         # whsec_... from POST /api/webhooks
PUBLIC_URL=             # cloudflared or ngrok tunnel
OPENAI_API_KEY=
OPENAI_MODEL=
APPROVER_USER_ID=       # Alex
REQUESTER_USER_ID=      # Arne
```

Setup order: `npx ambiguous auth signup` then `POST /api/admin/users/provision-agent` then tunnel then `POST /api/webhooks`, and verify one real event lands before any business logic exists.

---

## 12. Instructions for the coding agent

1. **Fetch `https://app.ambiguous.ai/api/openapi.json` before implementing anything.** Where it contradicts this document, the spec wins. Do not invent endpoints. If something here has no equivalent, stop and leave a TODO naming the closest real endpoint.
2. **Confirm the webhook event enum.** Known events are `task.assigned`, `email.received`, `document.shared`. Task completion is unconfirmed. If absent, implement `pollTasks()` on a 3 second interval routed through the same handler.
3. **Confirm the `content` shape for `POST /api/documents`.** Docs show both a markdown string and a block array. Support whichever the spec defines behind one `renderDoc()` helper.
4. Never call a cloud provider API. The adapter reads `fixtures/` only, behind an interface the README documents as swappable.
5. Prompts live only in `src/engine/prompts.ts` and return strict JSON. No prompt decides policy.
6. Dependencies: Node built-ins, the OpenAI SDK, a YAML parser. Nothing else.
7. Write only within your assigned owner's paths.

---

## 13. Timeline

- **11:00 to 11:15** Read the starter kit output. Adjust this document if the rubric or repo demands it. Write nothing before 11:00.
- **11:15 to 11:50** Both: integration spike, then commit `types.ts` and `stub.ts` and split.
- **11:50 to 12:30** Arne: fixtures and policy rules by hand. Alex: Ambiguous client and writers against the stub.
- **12:30** Five minute pause. Write the six video shots on paper.
- **12:30 to 13:15** Arne: prompts, blast radius, doc rendering. Alex: router, approval detection, polling fallback, record store.
- **13:15 to 13:45** Both: integrate. Replace the stub with the real `analyze()`. Expect it to be ugly. Protect this window, there is no third person to keep building while you debug the seam.
- **13:45 to 14:15** First clean end to end. Then the refusal path. Expiry only if both are solid.
- **14:15 to 14:45** Four clean runs. Fix the two things that break. **Freeze at 14:45 regardless of state.**
- **14:45 to 15:15** Record together, both accounts on camera. README. Social post. Submit.
- **Submit by 15:15.**

Draft the written description and the social post over lunch while the pitch is fresh. At 15:00 you will write them badly.

Commit straight to main. Disjoint ownership makes it safe. Push often.

---

## 14. Definition of done

By 14:45, someone who has never seen this can watch two minutes and understand that a request arrived as a plain email, an agent turned it into a checked, scoped, human-approved change, a different human approved it, and the whole chain is reconstructable six months later in artifacts the team already uses.

Everything else is optional.
