# Arne's engine workstream

`analyze({ text, from }): Promise<Analysis>` is frozen in `src/types.ts`.
`index.ts` currently exports the **hardcoded fixture-01 stub for every input**.
This is an integration scaffold, not a parser or a policy engine. Do not connect
unreviewed live inbound requests to it. Fixture 02 and 03 outcomes remain TODO.
The stub preserves the actual sender and raw input; the router supplies unique
record ids. Every call returns an independent object.

Alex can call `renderAnalysisDoc(analysis)` to get `{ title, content }`, with
`content` as Markdown. Alex's document adapter owns conversion to the actual
workspace API payload. The renderer handles both accepted-for-review and refused
analyses, but the stub itself only returns the fixture-01 review path.

## Build next, in this order

1. Implement a fixture-only IAM adapter reading `fixtures/iam/roles.json`
   (`role -> permission[]`) and `bindings.json` (`resource -> role -> Principal[]`).
   Its public operations should resolve role permissions and resource holders.
   A future adapter can replace these lookups behind the same interface; no
   cloud API may be called in this project.
2. Implement strict `AccessRequest` validation after the parse model call. All
   prompts stay in `prompts.ts`; model selection comes from `OPENAI_MODEL`.
   Derive relative dates from trusted message time, never the model's clock.
3. Load `policy/access.yaml` and implement its six named conditions in code.
   Unsupported rules and missing IAM resources/roles must fail closed. The frozen
   request type has no approver: read the configured approver for SELF-APPROVAL,
   and coordinate with Alex's router's identity check without changing the seam.
4. Resolve blast radius, find a narrower role from the verified stated need,
   and produce findings/recommendations deterministically. Explain may return
   rationale only. Production duration defaults and recommendation selection
   belong in code, never in a model decision.
5. Add all three scenario tests, including the refusal's two blocking rule ids,
   null recommendation, and clean staging pass. Replace the stub export only
   after these pass. Coordinate the change with Alex.

## Fixture scope and expected outcomes

All names, projects and access bindings are invented. These are hand-authored,
bounded examples, **not complete Google Cloud permission sets**, effective-access
resolution, inherited IAM policies, conditions, or deny policies. Keep this
limitation visible in the analysis document. Permission examples were checked
against Google's [Cloud Storage roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles)
and [Cloud Logging access control](https://docs.cloud.google.com/logging/docs/access-control).
Object Creator permits new objects; overwriting existing objects needs additional
permissions and must not silently receive the same recommendation.

| Input | Expected real-engine result |
| --- | --- |
| `01-pipeline.eml` | PROD-EXPIRY and LEAST-PRIV warnings; Object Creator, 30 days; human review |
| `02-shortcut.eml` | NO-BASIC-ROLES and SEP-DUTIES blocks; refused; no recommendation |
| `03-routine.eml` | All rules pass; Logging Viewer, 7 days; human review |

Fixture 01 deliberately names Alex as reviewer. For the live demo, replace the
synthetic email identity with Arne's provisioned requester account. Sender identity
must come from trusted intake metadata, not an email-body assertion.
