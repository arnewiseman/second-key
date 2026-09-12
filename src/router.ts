import { randomUUID } from "node:crypto";
import type { DecisionRecord, Principal } from "./types.ts";
import type { Analyze, Workspace } from "./ports.ts";
import { renderAnalysisDoc } from "./engine/render.ts";
import { RecordStore } from "./record/store.ts";

/** Initial intake seam. Live delivery deduplication/recovery belongs to Alex. */
export function createRouter(deps: {
  analyze: Analyze; workspace: Workspace; records: RecordStore;
  approver: Principal; now?: () => Date;
}) {
  const timestamp = () => (deps.now?.() ?? new Date()).toISOString();
  return {
    async receive(inbound: { text: string; from: Principal }): Promise<DecisionRecord> {
      if (deps.approver.kind !== "user" || deps.approver.id === inbound.from.id ||
          deps.approver.email.trim().toLowerCase() === inbound.from.email.trim().toLowerCase()) {
        throw new Error("SELF-APPROVAL: requester and human approver must differ");
      }
      const analysis = await deps.analyze(inbound);
      const id = randomUUID();
      const createdAt = timestamp();
      let record: DecisionRecord = {
        id, created_at: createdAt, analysis, doc_url: null, task_id: null,
        approver: deps.approver, approved_at: null, approval_comment: null, expires_at: null,
        state: "analyzing", events: [{ at: createdAt, actor: "reeve", what: "Analysis prepared; no grant executed" }],
      };
      await deps.records.save(record);
      async function update(patch: Partial<DecisionRecord>, what: string) {
        record = { ...record, ...patch, events: [...record.events, { at: timestamp(), actor: "reeve", what }] };
        await deps.records.save(record);
      }
      if (analysis.refused) {
        const reason = analysis.refusal_reason ?? analysis.findings.filter(f => f.severity === "block").map(f => `${f.rule_id}: ${f.message}`).join("; ");
        await update({ state: "refused" }, `Request refused: ${reason}`);
        await deps.workspace.sendRefusal({ to: inbound.from, reason, recordId: id });
        await update({}, "Refusal email sent; no approval task created");
        return record;
      }
      const doc = await deps.workspace.createDocument(renderAnalysisDoc(analysis));
      await update({ doc_url: doc.url }, "Analysis document created");
      const task = await deps.workspace.createApprovalTask({ title: analysis.decision_required, docUrl: doc.url, approver: deps.approver });
      await update({ task_id: task.id, state: "awaiting_approval" }, "Approval task created for separate human");
      return record;
    },
  };
}
