import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEmailEvent, verifyWebhook } from "../src/webhook.ts";
import { createApp } from "../src/server.ts";
import { IntakeStore } from "../src/record/intake.ts";

const rawBody = await readFile(new URL("../fixtures/webhooks/email.received.json", import.meta.url));
const secret = "synthetic-test-secret";
const now = new Date("2026-09-12T20:00:00Z");
const timestamp = String(now.getTime() / 1000);
function sign(time = timestamp, body = rawBody) { return createHmac("sha256", secret).update(`${time}.`).update(body).digest("hex"); }

test("webhook HMAC rejects tampering, malformed signatures, old/future timestamps", () => {
  const input = { rawBody, secret, now, timestamp, signature: sign() };
  assert.equal(verifyWebhook(input), true);
  assert.equal(verifyWebhook({ ...input, signature: `sha256=${sign()}` }), true);
  assert.equal(verifyWebhook({ ...input, rawBody: Buffer.from("{}")} ), false);
  for (const signature of ["", "f".repeat(63), "g".repeat(64), sign()+"00"]) assert.equal(verifyWebhook({ ...input, signature }), false);
  for (const time of [String(Number(timestamp)-301), String(Number(timestamp)+301), timestamp+"junk"]) {
    assert.equal(verifyWebhook({ ...input, timestamp: time, signature: sign(time) }), false);
  }
});

test("HTTP intake acknowledges enqueue and rejects unsigned delivery", async t => {
  let accepted = 0;
  const app = createApp({ secret, now: () => now, enqueue: async event => { assert.equal(event.event, "email.received"); accepted++; } });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/webhooks/ambiguous`;
  const started = Date.now();
  const good = await fetch(url, { method: "POST", headers: { "x-webhook-timestamp": timestamp, "x-webhook-signature": sign() }, body: rawBody });
  assert.equal(good.status, 200);
  await good.text();
  assert.ok(Date.now() - started < 2000);
  const bad = await fetch(url, { method: "POST", body: rawBody });
  assert.equal(bad.status, 401);
  await bad.text();
  assert.equal(accepted, 1);
});

test("HTTP intake persists a delivery before acknowledgment and skips duplicate enqueue", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intake = new IntakeStore(directory);
  let enqueued = 0;
  const app = createApp({ secret, now: () => now, intake, enqueue: async () => { enqueued++; } });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/webhooks/ambiguous`;
  for (let index = 0; index < 2; index++) {
    const response = await fetch(url, { method: "POST", headers: { "x-webhook-timestamp": timestamp, "x-webhook-signature": sign() }, body: rawBody });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(enqueued, 1);
  assert.equal((await intake.list()).length, 1);
});

test("HTTP intake rejects a persisted-delivery request without a delivery ID", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intake = new IntakeStore(directory);
  const app = createApp({ secret, now: () => now, intake, enqueue: async () => {} });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())));
  const body = Buffer.from(JSON.stringify({ event: "email.received", data: { id: "mail-1" } }));
  const response = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/webhooks/ambiguous`, {
    method: "POST",
    headers: { "x-webhook-timestamp": timestamp, "x-webhook-signature": sign(timestamp, body) },
    body,
  });
  assert.equal(response.status, 400);
  await response.text();
});

test("normalizes an inline email with trusted sender and delivery identity", async () => {
  const requester = { id: "requester", kind: "user" as const, email: "arne@example.test" };
  const normalized = await normalizeEmailEvent({
    event: "email.received",
    data: {
      id: "mail-1",
      from: { id: "requester", email: "arne@example.test" },
      body_text: "Request access to the production bucket.",
      thread_id: "thread-1",
      message_id: "message-1",
      received_at: "2026-09-12T20:00:00.000Z",
    },
  }, {
    deliveryId: "delivery-1",
    resolvePrincipal: participant => participant.email === requester.email ? requester : null,
  });
  assert.deepEqual(normalized, {
    deliveryId: "delivery-1",
    emailId: "mail-1",
    text: "Request access to the production bucket.",
    from: requester,
    receivedAt: "2026-09-12T20:00:00.000Z",
    threadId: "thread-1",
    messageId: "message-1",
  });
});

test("fetches email content when the event contains only an email ID", async () => {
  const requester = { id: "requester", kind: "user" as const, email: "arne@example.test" };
  let fetchedId = "";
  const normalized = await normalizeEmailEvent({ event: "email.received", data: { id: "mail-2" } }, {
    deliveryId: "delivery-2",
    getEmail: async id => {
      fetchedId = id;
      return { id, from: { email: requester.email }, body_text: "Needs access.", received_at: "2026-09-12T20:01:00Z" };
    },
    resolvePrincipal: participant => participant.email === requester.email ? requester : null,
  });
  assert.equal(fetchedId, "mail-2");
  assert.equal(normalized.emailId, "mail-2");
  assert.equal(normalized.text, "Needs access.");
});

test("rejects unsupported or untrusted email events", async () => {
  const options = { deliveryId: "delivery-3", resolvePrincipal: () => null };
  await assert.rejects(normalizeEmailEvent({ event: "task.assigned", data: {} }, options), /Unsupported webhook event/);
  await assert.rejects(normalizeEmailEvent({ event: "email.received", data: { id: "mail-3", body_text: "Access" } }, options), /sender/);
  await assert.rejects(normalizeEmailEvent({ event: "email.received", data: { id: "mail-4", from: "arne@example.test", body_text: "Access" } }, { ...options, deliveryId: undefined }), /delivery ID/);
});
