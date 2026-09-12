import type { Analysis } from "../types.ts";

export type AnalysisDocument = { title: string; content: string };

function plain(value: string): string {
  return value.replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, "\\$1");
}

function bullets(values: string[]): string {
  return values.length ? values.map((value) => `- ${plain(value)}`).join("\n") : "- None recorded.";
}

/** Markdown is the engine/writer seam; the workspace adapter owns API serialization. */
export function renderAnalysisDoc(analysis: Analysis): AnalysisDocument {
  const { request, blast_radius: blast, recommendation } = analysis;
  const title = `Access request: ${request.resource} for ${request.requester.email}`;
  const proposal = recommendation && !analysis.refused
    ? `Propose ${plain(recommendation.role)} on ${plain(request.resource)} for ${plain(request.requester.email)}, limited to ${recommendation.duration_days} days. Human approval is required before anyone performs a change.`
    : "No change is proposed. This request is refused.";
  const recommendationText = recommendation && !analysis.refused
    ? `${plain(recommendation.role)} for ${recommendation.duration_days} days. Narrower than requested: ${recommendation.narrower_than_requested ? "yes" : "no"}.\n\n${plain(recommendation.rationale)}`
    : `No recommendation. ${plain(analysis.refusal_reason ?? "See blocking policy findings.")}`;

  return {
    title,
    content: [
      "Prepared by Reeve. This record proposes access; Reeve never executes a grant.",
      "## Request",
      `Requester: ${plain(request.requester.email)} (${plain(request.requester.id)})\n\nResource: ${plain(request.resource)}\n\nRequested role: ${plain(request.requested_role)}\n\nReason: ${plain(request.justification)}\n\nNeeded by: ${plain(request.needed_by ?? "Not specified")}\n\nRequested duration: ${request.duration_days === null ? "Not specified" : `${request.duration_days} days`}\n\nAsserts prior approval: ${request.asserts_prior_approval ? "yes" : "no"}\n\nSource: ${plain(request.source)}; request id: ${plain(request.id)}\n\nOriginal request:\n\n${request.raw_text.split(/\r?\n/).map((line) => `> ${plain(line)}`).join("\n")}`,
      "## Proposed change",
      proposal,
      "## Blast radius",
      `Requested role: ${plain(blast.role)} on ${plain(blast.resource)}.\n\nIllustrative fixture permissions (not a complete IAM inventory):\n\n${bullets(blast.permissions)}\n\nAlso grants beyond the stated need:\n\n${bullets(blast.also_grants)}\n\nExisting holders on this resource (possibly under other roles):\n\n${bullets(blast.existing_holders.map((holder) => `${holder.email} (${holder.kind})`))}\n\nScope limitations:\n\n${bullets(blast.does_not_cover)}`,
      "## Policy checks",
      bullets(analysis.findings.map((finding) => `${finding.rule_id} — ${finding.severity.toUpperCase()}: ${finding.message}`)),
      "## Recommendation",
      recommendationText,
      "## Decision required",
      analysis.refused
        ? `Refused: ${plain(analysis.refusal_reason ?? "See blocking policy findings.")} No approval task should be created.`
        : plain(analysis.decision_required),
    ].join("\n\n"),
  };
}
