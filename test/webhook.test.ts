import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { verifyWebhook } from "../src/webhook.ts";
import { createApp } from "../src/server.ts";

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
