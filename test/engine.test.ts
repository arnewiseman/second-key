import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyze } from "../src/engine/stub.ts";
import { renderAnalysisDoc } from "../src/engine/render.ts";
import type { Principal } from "../src/types.ts";

const sender: Principal = { id: "user-priya", kind: "user", email: "priya.raman@acme.example" };

test("fixture-01 stub preserves intake identity and returns a bounded review proposal", async () => {
  const text = await readFile(new URL("../fixtures/inbound/01-pipeline.eml", import.meta.url), "utf8");
  const result = await analyze({ text, from: sender });
  assert.equal(result.request.raw_text, text);
  assert.deepEqual(result.request.requester, sender);
  assert.equal(result.refused, false);
  assert.equal(result.recommendation?.role, "roles/storage.objectCreator");
  assert.equal(result.recommendation?.duration_days, 30);
  assert.equal(result.recommendation?.narrower_than_requested, true);
  assert.deepEqual(result.findings.filter((finding) => finding.severity === "warn").map((finding) => finding.rule_id), ["PROD-EXPIRY", "LEAST-PRIV"]);
  const roles = JSON.parse(await readFile(new URL("../fixtures/iam/roles.json", import.meta.url), "utf8")) as Record<string, string[]>;
  assert.deepEqual(result.blast_radius.permissions, roles[result.request.requested_role]);
  assert.ok(result.blast_radius.permissions.includes("storage.objects.delete"));
  assert.ok(result.blast_radius.permissions.includes("storage.buckets.setIamPolicy"));
  assert.equal(result.blast_radius.existing_holders.length, 2);
  result.request.requester.email = "changed@acme.example";
  result.blast_radius.permissions.length = 0;
  const next = await analyze({ text, from: sender });
  assert.equal(sender.email, "priya.raman@acme.example");
  assert.ok(next.blast_radius.permissions.length > 0);
});

test("document exposes six review sections, original evidence, and a refusal without a proposed grant", async () => {
  const analysis = await analyze({ text: "Please review\n## injected heading", from: sender });
  const doc = renderAnalysisDoc(analysis);
  assert.equal(doc.title, "Access request: gs://prod-events-raw for priya.raman@acme.example");
  assert.deepEqual([...doc.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ["Request", "Proposed change", "Blast radius", "Policy checks", "Recommendation", "Decision required"]);
  assert.match(doc.content, /Illustrative fixture permissions/);
  assert.match(doc.content, /> Please review/);
  analysis.refused = true;
  analysis.refusal_reason = "NO-BASIC-ROLES and SEP-DUTIES blocked this request.";
  analysis.recommendation = null;
  const refusedDoc = renderAnalysisDoc(analysis);
  assert.match(refusedDoc.content, /No change is proposed/);
  assert.match(refusedDoc.content, /No approval task should be created/);
  assert.doesNotMatch(refusedDoc.content, /Propose roles/);
});
