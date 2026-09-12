The model parses free text and writes rationale. It never determines a policy outcome. Verdicts come from YAML rules.

# Second Key

Reeve is an AI coworker that prepares scoped access changes, asks a separate human to approve, and keeps the decision chain reconstructable. **It never executes a grant.** Cloud data comes exclusively from invented local fixtures.

This repository is a **two-person build with an implemented engine and integrated workspace loop**. Read [prd.MD](prd.MD) for product requirements and [goal.MD](goal.MD) for the event brief. The newer two-person PRD governs conflicts with the brief's older three-person team and interface-freeze notes. The original source documents are preserved.

## Run locally

Use Node 22.18 or newer. Runtime dependencies are the OpenAI SDK and YAML parser; TypeScript and Node types are development tools. No framework, database, ORM, or cloud SDK.

```sh
npm ci
cp .env.example .env
npm run check
npm run smoke
npm run dev
```

`GET http://127.0.0.1:3000/health` reports the configured runtime status. `npm run smoke` makes an offline fixture-01 document, task payload, and audit record under ignored `data/smoke/`. It makes no network calls and needs no keys. It is a development check, not the PRD's cut demo-mode feature.

Set `REEVE_ENABLED=1` to activate durable webhook intake and the real engine. Startup requires the configured requester and separate human approver, workspace agent key, webhook secret, real calendar ID, agreed future change-window timestamps, and verified webhook field paths listed in `.env.example`. Without activation, the health server runs and webhook requests return 503. A single background loop processes persisted emails and polls approval tasks every three seconds without overlapping runs.

Use OpenAI configuration, or `MODEL_PROVIDER=deepseek` with `DEEPSEEK_MODEL` and `DEEPSEEK_API_KEY`. The engine never falls back to the stub. All three parser fixtures have passed with live DeepSeek and fake identities. Workspace operation requires actual account IDs; fake IDs are only suitable for local tests.

## Integration status

Arne’s engine and Alex’s intake/approval foundations are integrated with the executable server, approval polling, calendar booking, closing email, and durable audit records. The full loop is tested with mocked workspace services and model transport. Live workspace acceptance remains outstanding; see [the handoff checklist](docs/handoff.md). The shared product types and workspace ports remain unchanged.

The frozen product boundary is:

```ts
analyze(inbound: { text: string; from: Principal }): Promise<Analysis>
```

Offline tests can import `analyze` from `src/engine/stub.ts`; the executable runtime uses the real engine. `createAnalyzer({ complete, approver, now? })` allows engine-local injection of a model transport and the same approver used by the router. Arne also supplies `renderAnalysisDoc(analysis): { title, content }`; content is Markdown. Shared `src/ports.ts` describes internal workspace operations, separate from external API payloads.

See [the handoff checklist](docs/handoff.md) for independent task order and acceptance gates, and [the verified Ambiguous contract](docs/ambiguous-api.md) before connecting live services.

## Architecture and implemented boundary

```text
Signed webhook → durable, deduplicated intake → fetch trusted email
                                                    ↓
                         real engine → deterministic YAML policy
                                                    ↓
                         document + approval task OR refusal mail
                                    ↓
                  poll exact task + attributable human comment
                                    ↓
                     calendar → decision mail → audit closeout
```

The receiver authenticates raw bytes and persists intake before acknowledging, without waiting for model or workspace calls. It deduplicates deliveries, rejects conflicting reuse, bounds pending jobs, and binds requester identity to the fetched email’s configured user ID and email. A stable email-based record ID also prevents repeat work across distinct deliveries for the same email.

Only an explicit, unedited approval comment from the configured human on the exact assigned task can start closeout. Task completion alone is insufficient. The final mail names the role, resource, grantee, change window, expiry and analysis document. Reeve never executes an IAM grant.

JSON records preserve immutable original analysis and append-only audit history. Writes are flushed and atomically replaced. Run one server process per record directory. Interrupted intake and uncertain non-idempotent document/task/calendar outcomes require reconciliation; a durable calendar intent prevents blind replay. Mail retries preserve the original payload and idempotency key. These files are a local audit trail, not a tamper-proof audit service. See the handoff recovery procedure before retrying failed work.

The engine's read-only `IamResolver` loads `fixtures/iam/roles.json`, `bindings.json`, and explicit production/staging metadata in `resources.json`. Permission matching supports bounded new-object, object-read, and log-read use cases; unknown or mixed needs block for clarification. Fixture permissions are illustrative subsets, not exhaustive IAM inventories. See [Arne's engine handoff](src/engine/README.md) for the exact integration contract and evidence limits.

## Environment and verification

`.env.example` lists integration variables; keep real credentials local. Model names come from configuration. Routine workspace writes use `AMBIGUOUS_AGENT_KEY`; the admin key is only for provisioning. `WEBHOOK_EVENT_TYPE_PATH`, `WEBHOOK_EMAIL_ID_PATH` and `WEBHOOK_DELIVERY_ID_PATH` are all relative to the complete provider envelope. Set these from a captured real payload; the specification does not define event-specific fields and the runtime deliberately supplies no guessed defaults.

`npm run check` runs strict typechecking and native Node tests, including the full signed-webhook-to-closeout flow with mocked services, refusal, duplicate/restart handling, and approval attacks. GitHub Actions also runs the offline smoke flow. Live acceptance on September 12 verified signed intake, analysis creation, Alex's attributable approval, calendar booking, received closing mail, and the Owner-request refusal. See [the recorded demo](demo/README.md) and [handoff evidence](docs/handoff.md). Expiry lifecycle is stretch scope and is not implemented.
