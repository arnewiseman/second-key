import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AmbiguousClient } from "../src/ambiguous/client.ts";
import { createRuntime } from "../src/runtime.ts";
import { createApp } from "../src/server.ts";
import { createAnalyzer } from "../src/engine/index.ts";
import { loadRuntimeConfig } from "../src/config.ts";

const requester = { id: "requester", kind: "user" as const, email: "requester@example.test" };
const approver = { id: "approver", kind: "user" as const, email: "approver@example.test" };
const window = { calendarId: "calendar", start: "2026-09-14T10:00:00Z", end: "2026-09-14T11:00:00Z" };

test("signed webhook -> real engine -> workspace task -> attributable approval -> calendar/mail/record", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-runtime-"));
  const happy = await readFile("fixtures/inbound/01-pipeline.eml", "utf8");
  const shortcut = await readFile("fixtures/inbound/02-shortcut.eml", "utf8");
  let now = new Date("2026-09-12T20:00:00Z");
  let approved = false;
  let modelCalls = 0;
  const calls: { path: string; method: string; body: Record<string, unknown> | null; key: string | null }[] = [];
  const client = new AmbiguousClient({ baseUrl: "https://example.test", agentKey: "test-placeholder", log: () => {}, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init!.method!, body: init?.body ? JSON.parse(String(init.body)) : null,
      key: new Headers(init?.headers).get("Idempotency-Key") });
    if (path.startsWith("/api/mail/") && init?.method === "GET") {
      const id = path.split("/").at(-1);
      return Response.json({ id, from: id === "untrusted" ? { id: "attacker", email: requester.email } : requester,
        body_text: id === "refusal" ? shortcut : happy, read: false, received_at: "1999-01-01T00:00:00Z" });
    }
    if (path === "/api/documents") return Response.json({ id: "doc-1", title: "Analysis", type: "doc" });
    if (path === "/api/tasks" || path === "/api/tasks/task-1") return Response.json({ task: {
      id: "task-1", title: "Approve", status: approved ? "done" : "todo", assignee_id: approver.id, completed_at: approved ? now.toISOString() : null,
    } });
    if (path.endsWith("/comments")) return Response.json({ data: approved ? [{ id: "comment-1", task_id: "task-1", content: "Approved.",
      author: { id: approver.id, primary_email: approver.email, display_name: "Alex" }, created_at: now.toISOString(), updated_at: null, replies: [] }] : [],
      has_more: false, total: approved ? 1 : 0 });
    if (path.includes("/calendars/")) return Response.json({ id: "event-1", calendar_id: window.calendarId });
    if (path === "/api/mail/send") return Response.json({ id: "sent-1", read: false });
    throw new Error("Unexpected API route");
  } });
  const analyze = createAnalyzer({ approver, now: () => now, complete: async call => {
    modelCalls++;
    if (call.kind === "explain") return JSON.stringify({ rationale: "A separate human must review the proposed scope." });
    const input = JSON.parse(call.input);
    const refused = input.untrusted_email.includes("roles/owner");
    return JSON.stringify({ id: input.request_id, raw_text: input.untrusted_email, requester: input.trusted_sender,
      source: "email", resource: refused ? "projects/acme-data-prod" : "gs://prod-events-raw",
      requested_role: refused ? "roles/owner" : "roles/storage.admin", duration_days: null, needed_by: null,
      asserts_prior_approval: refused, justification: refused ? "" : "Data engineering's nightly parquet export is ready to move over." });
  } });
  const runtime = createRuntime({ client, analyze, requester, approver, window, emailIdPath: "email_ref", recordDir: directory, now: () => now, log: () => {} });
  const secret = "synthetic-test-placeholder";
  const app = createApp({ secret, intake: runtime.intake, enqueue: runtime.enqueue, deliveryIdPath: "delivery_id", engine: "real", now: () => now });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(async () => { await new Promise<void>(resolve => app.close(() => resolve())); await runtime.stop(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  async function deliver(deliveryId: string, emailId: string) {
    // These paths are explicitly synthetic test configuration, not a provider claim.
    const body = JSON.stringify({ event: "email.received", delivery_id: deliveryId,
      data: { email_ref: emailId, body_text: "Untrusted inline text must be ignored", from: approver } });
    const time = String(now.getTime() / 1000);
    const signature = createHmac("sha256", secret).update(`${time}.${body}`).digest("hex");
    const response = await fetch(`${base}/webhooks/ambiguous`, { method: "POST", body,
      headers: { "x-webhook-timestamp": time, "x-webhook-signature": signature } });
    await response.text();
    assert.equal(response.status, 200);
  }
  await deliver("delivery-1", "happy");
  assert.equal(calls.length, 0); assert.equal(modelCalls, 0); // ACK happens before model/API work.
  await runtime.tick();
  const record = (await runtime.records.list())[0]!;
  assert.equal(record.state, "awaiting_approval"); assert.equal(record.analysis.request.raw_text, happy);
  assert.equal(record.analysis.request.requester.id, requester.id);
  await deliver("delivery-1", "happy");
  await deliver("delivery-2", "happy");
  await runtime.tick();
  assert.equal((await runtime.records.list()).length, 1); assert.equal(modelCalls, 2);
  assert.equal(calls.filter(call => call.path === "/api/documents").length, 1);
  now = new Date("2026-09-12T20:01:00Z"); approved = true;
  await Promise.all([runtime.tick(), runtime.tick()]);
  const closed = await runtime.records.get(record.id);
  assert.equal(closed?.state, "approved"); assert.equal(closed?.approved_at, now.toISOString());
  assert.equal(closed?.expires_at, "2026-10-14T10:00:00.000Z");
  assert.ok(closed?.events.some(event => event.what.includes("comment=comment-1")));
  await runtime.tick();
  assert.equal(calls.filter(call => call.path.includes("/calendars/")).length, 1);
  const closing = calls.filter(call => call.path === "/api/mail/send");
  assert.equal(closing.length, 1); assert.equal(closing[0]!.key, `${record.id}:decision`);
  assert.match(String(closing[0]!.body?.body_markdown), /roles\/storage.objectCreator/);
  assert.match(String(closing[0]!.body?.body_markdown), /has not executed/);
  await deliver("delivery-refusal", "refusal"); await runtime.tick();
  assert.equal((await runtime.records.list()).find(item => item.state === "refused")?.task_id, null);
  assert.equal(calls.filter(call => call.path === "/api/tasks").length, 1);
  const refusal = calls.filter(call => call.path === "/api/mail/send").at(-1)!;
  assert.match(String(refusal.body?.body_markdown), /NO-BASIC-ROLES/); assert.match(String(refusal.body?.body_markdown), /SEP-DUTIES/);
  await deliver("delivery-untrusted", "untrusted"); await runtime.tick();
  assert.equal((await runtime.records.list()).length, 2);
  assert.equal((await runtime.intake.getByDeliveryId("delivery-untrusted"))?.state, "failed");
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.engine, "real"); assert.equal(health.webhook, "configured");
});

test("live activation requires explicit verified field paths and separate configured identities", () => {
  assert.equal(loadRuntimeConfig({}), null);
  assert.throws(() => loadRuntimeConfig({ REEVE_ENABLED: "1" }), /APPROVER_USER_ID/);
  const env = { REEVE_ENABLED: "1", APPROVER_USER_ID: approver.id, APPROVER_EMAIL: approver.email,
    REQUESTER_USER_ID: requester.id, REQUESTER_EMAIL: requester.email, CALENDAR_ID: window.calendarId,
    CHANGE_START_AT: window.start, CHANGE_END_AT: window.end, WEBHOOK_SECRET: "test-placeholder", AMBIGUOUS_AGENT_KEY: "test-placeholder",
    WEBHOOK_EMAIL_ID_PATH: "mail.id", WEBHOOK_DELIVERY_ID_PATH: "delivery.id" };
  assert.equal(loadRuntimeConfig(env)?.emailIdPath, "mail.id");
  assert.throws(() => loadRuntimeConfig({ ...env, REQUESTER_USER_ID: approver.id }), /must differ/);
  assert.throws(() => loadRuntimeConfig({ ...env, WEBHOOK_EMAIL_ID_PATH: "" }), /required/);
  assert.throws(() => loadRuntimeConfig({ ...env, WEBHOOK_EMAIL_ID_PATH: "__proto__.id" }), /verified/);
  assert.throws(() => loadRuntimeConfig({ ...env, CHANGE_END_AT: window.start }), /window/);
});
