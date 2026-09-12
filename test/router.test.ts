import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../src/engine/stub.ts";
import { RecordStore } from "../src/record/store.ts";
import { createRouter } from "../src/router.ts";
import type { Workspace } from "../src/ports.ts";

const from = { id: "requester", kind: "user" as const, email: "arne@example.test" };
const approver = { id: "approver", kind: "user" as const, email: "alex@example.test" };
const inbound = { text: "Fixture 01 input", from };

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "second-key-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = new RecordStore(directory);
  const calls: string[] = [];
  const workspace: Workspace = {
    async createDocument(doc) { calls.push("document"); assert.ok(doc.content.includes("## Policy checks")); return { url: "https://example.test/docs/1" }; },
    async createApprovalTask(task) { calls.push("task"); assert.equal(task.approver.id, approver.id); assert.equal(task.docUrl, "https://example.test/docs/1"); return { id: "task-1" }; },
    async sendRefusal(mail) { calls.push("refusal"); assert.match(mail.reason, /NO-BASIC-ROLES/); assert.match(mail.reason, /SEP-DUTIES/); },
  };
  return { records, calls, workspace };
}

test("intake persists document and separate-human task with append-only audit history", async t => {
  const deps = await setup(t);
  const record = await createRouter({ ...deps, analyze, approver }).receive(inbound);
  assert.equal(record.state, "awaiting_approval");
  assert.deepEqual(deps.calls, ["document", "task"]);
  assert.equal(record.events.length, 3);
  assert.deepEqual(await deps.records.get(record.id), record);
  await assert.rejects(deps.records.save({ ...record, events: [] }), /history cannot/);
  await assert.rejects(deps.records.save({ ...record, state: "approved" }), /require an audit event/);
  await assert.rejects(deps.records.get("../escape"), /Invalid record/);
});

test("injected blocked analysis sends refusal naming both rules and never creates a task", async t => {
  const deps = await setup(t);
  const blocked = await analyze(inbound);
  blocked.refused = true;
  blocked.recommendation = null;
  blocked.refusal_reason = "NO-BASIC-ROLES: basic production role; SEP-DUTIES: claimed prior approval";
  const record = await createRouter({ ...deps, analyze: async () => blocked, approver }).receive(inbound);
  assert.equal(record.state, "refused");
  assert.equal(record.task_id, null);
  assert.deepEqual(deps.calls, ["refusal"]);
  assert.equal((await deps.records.get(record.id))?.events.length, 3);
});

test("self-approval is rejected before analysis or workspace writes", async t => {
  const deps = await setup(t);
  for (const invalid of [from, { ...approver, email: "ARNE@example.test" }, { ...approver, kind: "service_account" as const }]) {
    await assert.rejects(createRouter({ ...deps, analyze: async () => { throw new Error("Engine must not run"); }, approver: invalid }).receive(inbound), /SELF-APPROVAL/);
  }
  assert.deepEqual(deps.calls, []);
  assert.deepEqual(await deps.records.list(), []);
});
