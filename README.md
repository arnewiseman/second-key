The model parses free text and writes rationale. It never determines a policy outcome. Verdicts come from YAML rules.

# Second Key

Reeve is an AI coworker that prepares scoped access changes, asks a separate human to approve, and keeps the decision chain reconstructable. **It never executes a grant.** Cloud data comes exclusively from invented local fixtures.

This repository is a **two-person build with an implemented engine and a scaffolded workspace loop**. Read [prd.MD](prd.MD) for product requirements and [goal.MD](goal.MD) for the event brief. The newer two-person PRD governs conflicts with the brief's older three-person team and interface-freeze notes. The original source documents are preserved.

## Run locally

Use Node 22.18 or newer. Runtime dependencies are the OpenAI SDK and YAML parser; TypeScript and Node types are development tools. No framework, database, ORM, or cloud SDK.

```sh
npm ci
cp .env.example .env
npm run check
npm run smoke
npm run dev
```

`GET http://127.0.0.1:3000/health` reports the scaffold status. `npm run smoke` makes an offline fixture-01 document, task payload, and audit record under ignored `data/smoke/`. It makes no network calls and needs no keys. It is a development check, not the PRD's cut demo-mode feature.

The executable server deliberately returns **503** for webhooks until Alex wires a durable intake handler. HMAC validation, timestamp checks, envelope parsing, and an injectable HTTP receiver are implemented and tested. The engine entry point runs validated parsing, fixture resolution, deterministic YAML policy, and explanation. Use OpenAI configuration, or `MODEL_PROVIDER=deepseek` with `DEEPSEEK_MODEL` and `DEEPSEEK_API_KEY`. Both require `APPROVER_USER_ID` and `APPROVER_EMAIL`; the engine never falls back to the stub. Smoke explicitly imports the offline stub. All three parser fixtures have passed with live DeepSeek and fake identities; the complete workspace loop still requires acceptance testing.

## Split the work now

| Owner | Files | Next deliverable |
| --- | --- | --- |
| Arne | `src/engine/*`, `policy/*`, `fixtures/iam/*`, `fixtures/inbound/*`, engine tests | Implemented: parse → fixture lookup → YAML rules → explanation. All three parser cases passed with live DeepSeek; refusal routing is verified offline. |
| Alex | `src/server.ts`, `src/webhook.ts`, `src/router.ts`, `src/ambiguous/*`, `src/record/*`, loop tests, `fixtures/webhooks/*` | Connect verified workspace methods to intake; persist/deduplicate deliveries; detect attributable approval; calendar and closing email. |
| Together | `src/types.ts`, `src/ports.ts`, package/config/scripts/docs | Complete one real event + document spike, agree any contract changes, integrate and verify. |

The frozen product boundary is:

```ts
analyze(inbound: { text: string; from: Principal }): Promise<Analysis>
```

Alex can import `analyze` directly from `src/engine/stub.ts` for offline loop development, or use the real `src/engine/index.ts` export for integration. `createAnalyzer({ complete, approver, now? })` allows engine-local injection of a model transport and the same approver used by the router. Arne also supplies `renderAnalysisDoc(analysis): { title, content }`; content is Markdown. Shared `src/ports.ts` describes internal workspace operations, separate from external API payloads.

See [the handoff checklist](docs/handoff.md) for independent task order and acceptance gates, and [the verified Ambiguous contract](docs/ambiguous-api.md) before connecting live services.

## Architecture and implemented boundary

```text
Ambiguous webhook → signature verifier → durable intake (Alex TODO)
                                              ↓
                   router.receive({ text, from })
                         ↓                  ↓
                engine.analyze()      workspace port
                [implemented]        [injected adapter]
                                              ↓
                                    JSON decision record
```

The router currently persists analysis, routes accepted analyses into a document and human approval task, and routes refused analyses into a refusal email with no task. Refusal routing is tested with the real engine and a mocked model transport: both blocking rules reach the email and no task is created. A separate requester/approver guard runs before workspace writes. No approval closeout is implemented yet.

The file store atomically replaces JSON snapshots, rejects rewritten event history/original analysis, and requires an audit event for updates. It is single-process: Alex must serialize per-record writes and implement delivery deduplication/restart recovery before live intake. It is not a tamper-proof audit service. Record enrichment uses replacement snapshots with appended events; the original analysis remains unchanged.

The engine's read-only `IamResolver` loads `fixtures/iam/roles.json`, `bindings.json`, and explicit production/staging metadata in `resources.json`. Permission matching supports bounded new-object, object-read, and log-read use cases; unknown or mixed needs block for clarification. Fixture permissions are illustrative subsets, not exhaustive IAM inventories. See [Arne's engine handoff](src/engine/README.md) for the exact integration contract and evidence limits.

## Environment and verification

`.env.example` lists integration variables; copy real credentials locally only. `OPENAI_MODEL` must come from the starter kit/environment. `AMBIGUOUS_API_KEY` is for the joint admin provisioning spike; routine workspace writes use `AMBIGUOUS_AGENT_KEY`. Alex also needs a real calendar ID, approver ID/email, and separate requester ID.

`npm run check` runs strict typechecking and native Node tests. GitHub Actions runs that check plus the offline smoke flow on pushes. Live account provisioning, real webhook payload capture, document visibility, human approval, calendar booking, and outgoing email have **not** been exercised by this scaffold. Expiry lifecycle remains stretch scope; no `tick` command is claimed yet.
