# Arne's engine workstream

`src/engine/index.ts` exports the real `analyze({ text, from }): Promise<Analysis>`.
The separate `stub.ts` remains available for Alex's offline loop work and is the
explicit import used by `npm run smoke`. No runtime failure falls back to a stub.
The shared `Analysis`, `AccessRequest`, and workspace contracts are unchanged.

## Implemented

- `model.ts` uses the OpenAI SDK with OpenAI or DeepSeek Responses APIs, strict JSON schemas, no tools,
  `store: false`, a 30-second timeout, and no SDK retries. The configured model
  must support structured outputs. Errors omit provider details and request text.
- `validation.ts` checks model JSON at runtime. Application code binds requester,
  original text, source, and a SHA-256 request ID from trusted sender/text. Inputs
  are limited to 32 KiB. A stable analysis ID does not deduplicate webhook delivery.
- `fixtures.ts` reads and validates local roles, bindings, and resource metadata.
  `IamResolver` exposes copied role permissions, resource metadata, and holders.
  There are no cloud calls. Metadata explicitly distinguishes production/staging
  and bucket/project scope; names are never used as production heuristics.
- `policy.ts` evaluates all six original conditions plus `REQUEST-VALIDATION`.
  YAML supplies rule messages, severities, maximum duration and the 30-day default.
  Missing, duplicate, unknown or malformed rules fail initialization. Blocking
  safety rules cannot silently become pass/warn rules.
- `render.ts` preserves the six review headings and original evidence, shows the
  exact proposed role and duration, and explains that no grant has been executed.

The model parses facts and supplies explanation prose only. A valid parse is
followed by one explanation call, including for refused requests. Failed parsing
aborts before any analysis is returned. A failed/invalid explanation uses the
complete deterministic rationale. Explanation prose is labeled non-authoritative;
obvious invented scope and claims of completed approval/execution are rejected.
This is a bounded content check, not a guarantee of arbitrary prose correctness.
Refusal reasons always consist of deterministic rule IDs and messages.

## Integration

The default provider is OpenAI (`OPENAI_MODEL`, `OPENAI_API_KEY`). Set
`MODEL_PROVIDER=deepseek` to use `DEEPSEEK_MODEL` and `DEEPSEEK_API_KEY` instead.
Each provider uses its fixed official HTTPS origin; credentials never fall back
to the other provider. HTTP redirects are rejected. Model names remain configuration.
DeepSeek uses non-thinking mode for this bounded extraction/explanation task.

Both providers read `APPROVER_USER_ID` and `APPROVER_EMAIL` when called. Missing or
invalid configuration aborts. Never obtain requester identity from the model or email body.
Use the same configured human approver in the engine and Alex's router.

For isolated parser checks, `alex-test` and `alex@example.test` are sufficient
approver values, with a different fake requester. A real workspace approval task
requires the actual human's Ambiguous ID/email. Fake identities do not prove that
integration works. DeepSeek supports the existing protocol in its official
[Responses API guide](https://api-docs.deepseek.com/guides/responses_api/).

For tests or explicit integration injection:

```ts
import { createAnalyzer } from './src/engine/index.ts';

const analyze = createAnalyzer({
  complete, // engine-local (ModelCall) => Promise<string> transport
  approver, // same trusted Principal passed to createRouter
  now: () => trustedReferenceTime,
});
```

`now` supplies the trusted reference date for relative dates. The default is UTC
processing time because the frozen inbound interface has no message timestamp.
An email's `Date:` header never sets the clock. During delayed-message integration,
Alex can inject a trusted receipt time. The parsed needed-by date must be a real
ISO calendar date; relative-date interpretation still needs live model acceptance.

## Supported evidence and limits

This is intentionally a bounded fixture assessment, not a general IAM interpreter.
A request must name one explicit role/resource matching the model extraction and
quote an operational justification from the original text. The supported needs are:

- Creating new files/objects with unique names and explicit no-overwrite language.
  Object Creator is recommended only if its fixture permission set covers the
  recognized need and is a strict subset of the requested role's fixture set.
- Reading/listing existing objects, without mixed write or management operations.
- Reading application logs, without mixed storage or management operations.

Unknown roles/resources, unsupported scope combinations, absent justification,
ambiguous or additional operations, and requested roles that do not cover the need
produce a blocking `REQUEST-VALIDATION` finding. The conservative evidence matcher
may refuse legitimate paraphrases; ask for clarification instead of inventing
permissions or claiming coverage. Reading, deleting, and overwriting are not
covered by Object Creator.

Durations must be positive whole days matching explicit supported day/week text.
Numeric counts and a small set of common number words are supported. Contradictory
counts, unsupported month/year/expiry wording, or a model-added/dropped duration
block rather than silently receive the default. A genuinely absent duration can
receive the YAML default with `PROD-EXPIRY` warning on production resources.

The frozen contract represents the requester as grantee. Explicit requests for a
separate service account block until both owners agree a grantee contract. No
exact pipeline-account binding is claimed.

IAM fixtures are invented, illustrative subsets. They do not resolve inherited
policies, IAM conditions, deny rules or complete effective access. These limits
remain visible in the document. Original fixture examples were checked against
[Cloud Storage roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles)
and [Cloud Logging access control](https://docs.cloud.google.com/logging/docs/access-control).
The model transport follows the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).

## Verification and acceptance

`node --test test/engine*.test.ts` covers the real engine with hand-authored model
responses, the unchanged explicit stub, all three scenarios, malformed output,
trusted identity, deterministic policy failures, unsupported permissions and
negative/conflicting durations. A test routes the real fixture-02 engine result
through Alex's router: both blocking rule IDs reach the refusal email and no task
is created. Transport tests use a fake HTTP response through the actual SDK.

| Input | Verified offline result |
| --- | --- |
| `01-pipeline.eml` | PROD-EXPIRY + LEAST-PRIV warnings; Object Creator for 30 days |
| `02-shortcut.eml` | NO-BASIC-ROLES + SEP-DUTIES blocks; refused; no recommendation/task |
| `03-routine.eml` | All rules pass; Logging Viewer for 7 days; still human-reviewed |

Run `npm run check` and `npm run smoke` for integrated offline verification.
The three fixture parses and expected deterministic outcomes were also verified
against live DeepSeek using fake, separate requester/approver identities. No
workspace artifacts or grants were created. Document visibility, trusted workspace
identities, human approval, and calendar/mail delivery remain separate acceptance
gates. This small fixture run does not establish accuracy on arbitrary requests.
