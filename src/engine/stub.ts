import type { Analysis, Principal } from "../types.ts";

/** Integration scaffold only: every input receives the fixture-01 analysis. */
export async function analyze(inbound: { text: string; from: Principal }): Promise<Analysis> {
  // TODO(Arne): replace this implementation with parsing, fixture lookups, and YAML evaluation.
  // Alex may replace this stable fixture id with the inbound event's unique id.
  return {
    request: {
      id: "fixture-01",
      raw_text: inbound.text,
      requester: { ...inbound.from },
      resource: "gs://prod-events-raw",
      requested_role: "roles/storage.admin",
      justification: "Write new parquet objects for the nightly pipeline; existing objects are not overwritten.",
      needed_by: "2026-09-14",
      duration_days: null,
      asserts_prior_approval: false,
      source: "email",
    },
    findings: [
      { rule_id: "PROD-EXPIRY", severity: "warn", message: "Production access needs an explicit expiry; none was requested." },
      { rule_id: "MAX-DURATION", severity: "pass", message: "The fixture does not request more than 90 days." },
      { rule_id: "NO-BASIC-ROLES", severity: "pass", message: "Storage Admin is not a basic project role." },
      { rule_id: "SEP-DUTIES", severity: "pass", message: "The fixture does not assert prior approval." },
      { rule_id: "SELF-APPROVAL", severity: "pass", message: "Fixture assumes a separate approver; the router must verify the actual identities." },
      { rule_id: "LEAST-PRIV", severity: "warn", message: "Object Creator covers creation of new parquet objects without delete or bucket IAM permissions." },
    ],
    blast_radius: {
      resource: "gs://prod-events-raw",
      role: "roles/storage.admin",
      permissions: [
        "storage.buckets.get", "storage.buckets.update", "storage.buckets.delete",
        "storage.buckets.getIamPolicy", "storage.buckets.setIamPolicy",
        "storage.objects.create", "storage.objects.get", "storage.objects.list",
        "storage.objects.delete", "storage.objects.update",
      ],
      also_grants: ["Read and delete existing objects", "Change bucket configuration", "Change bucket IAM bindings", "Delete the bucket"],
      existing_holders: [
        { id: "sa-events-reader", kind: "service_account", email: "events-reader@acme-data-prod.iam.gserviceaccount.com" },
        { id: "sa-quality-check", kind: "service_account", email: "quality-check@acme-data-prod.iam.gserviceaccount.com" },
      ],
      does_not_cover: ["Other buckets or project-level access; this proposal is scoped to one bucket"],
    },
    recommendation: {
      role: "roles/storage.objectCreator",
      rationale: "Allow creation of new parquet objects for 30 days. This assumes unique object names: Object Creator does not permit reading, deleting, or overwriting existing objects. Fixture analysis only; confirm the job's actual needs before approval.",
      duration_days: 30,
      narrower_than_requested: true,
    },
    decision_required: `Approve roles/storage.objectCreator on gs://prod-events-raw for ${inbound.from.email} for 30 days?`,
    refused: false,
    refusal_reason: null,
  };
}
