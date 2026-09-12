// Frozen handoff contract from prd.MD section 9. Changes require Arne + Alex agreement.
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
