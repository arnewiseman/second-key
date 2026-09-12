import type { Principal } from "../types.ts";
import type { Analyze } from "../ports.ts";
import { loadFixtures } from "./fixtures.ts";
import type { IamResolver } from "./fixtures.ts";
import { loadPolicy, evaluate } from "./policy.ts";
import type { Policy } from "./policy.ts";
import { completionFromEnv } from "./model.ts";
import type { Complete } from "./model.ts";
import { EXPLAIN_SYSTEM_PROMPT, EXPLANATION_SCHEMA, explainInput, PARSE_SYSTEM_PROMPT, REQUEST_SCHEMA, parseInput } from "./prompts.ts";
import { checkExplanation, parseExplanation, parseRequest, principal, requestId, validateInbound } from "./validation.ts";

/** Engine-local injection leaves the frozen router contract unchanged. */
export function createAnalyzer(options: {
  complete: Complete; approver: Principal | null; iam?: IamResolver; policy?: Policy; now?: () => Date;
}): Analyze {
  const approver = options.approver === null ? null : { ...options.approver };
  let dependencies: Promise<[IamResolver, Policy]> | undefined;
  return async inbound => {
    validateInbound(inbound);
    // Snapshot input before awaiting: callers cannot change evidence mid-analysis.
    const input = { text: inbound.text, from: { ...inbound.from } };
    const reference = options.now?.() ?? new Date();
    if (!Number.isFinite(reference.getTime())) throw new Error("Invalid engine reference date");
    dependencies ??= Promise.all([options.iam ?? loadFixtures(), options.policy ?? loadPolicy()]);
    const [iam, policy] = await dependencies;
    let parsed: string;
    try {
      parsed = await options.complete({ kind: "parse", instructions: PARSE_SYSTEM_PROMPT,
        input: parseInput(input, requestId(input), reference.toISOString().slice(0, 10)), schema: structuredClone(REQUEST_SCHEMA) });
    } catch { throw new Error("Model parse failed; no analysis was prepared"); }
    const request = parseRequest(parsed, input);
    const analysis = evaluate(request, iam, policy, approver);
    try {
      const explanation = parseExplanation(await options.complete({ kind: "explain", instructions: EXPLAIN_SYSTEM_PROMPT,
        input: explainInput(analysis), schema: structuredClone(EXPLANATION_SCHEMA) }));
      checkExplanation(explanation, analysis);
      if (analysis.recommendation) {
        // The only model-authored result is labeled prose; all decision fields are fixed.
        analysis.recommendation.rationale += `\n\nModel explanation (non-authoritative; use the policy checks and exact proposal above):\n${explanation}`;
      }
      // Refusal reasons remain exclusively deterministic rule IDs and messages.
    } catch {
      // Explanation cannot turn a valid deterministic result into a different decision.
      if (analysis.recommendation) analysis.recommendation.rationale += "\n\nModel explanation unavailable; the deterministic assessment above is complete.";
    }
    return analysis;
  };
}

/** Runtime configuration is read only when invoked, never during import or smoke. */
export const analyze: Analyze = async inbound => {
  validateInbound(inbound);
  const approver: Principal = { id: process.env.APPROVER_USER_ID ?? "", kind: "user", email: process.env.APPROVER_EMAIL ?? "" };
  if (!principal(approver)) throw new Error("APPROVER_USER_ID and APPROVER_EMAIL must identify the configured human approver");
  return createAnalyzer({ approver, complete: completionFromEnv() })(inbound);
};
