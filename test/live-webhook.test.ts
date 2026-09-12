import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.ts';
import { IntakeStore } from '../src/record/intake.ts';
import { normalizeEmailEvent, parseEnvelope } from '../src/webhook.ts';

// Shape captured from a real delivery; all identities and content are synthetic.
const rawBody = await readFile(new URL('../fixtures/webhooks/email-received.live-redacted.json', import.meta.url));
const fixture = JSON.parse(rawBody.toString('utf8'));
const now = new Date('2026-09-12T20:01:00Z');
const timestamp = String(now.getTime() / 1000);
const secret = 'synthetic-live-contract-test-secret';
const requester = { id: '00000000-0000-4000-8000-000000000005', kind: 'user' as const, email: 'requester@example.test' };
const sign = (body: Buffer) => createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
const headers = (body: Buffer) => ({ 'x-webhook-timestamp': timestamp, 'x-webhook-signature': sign(body) });

test('explicit live event mapping retains the full envelope and ignores conflicting legacy fields', () => {
  const conflicting = { ...fixture, event: 'task.completed', delivery_id: 'untrusted-legacy-id' };
  const parsed = parseEnvelope(Buffer.from(JSON.stringify(conflicting)), 'type');
  assert.equal(parsed.event, 'email.received');
  assert.deepEqual(parsed.data, conflicting);
  assert.deepEqual(parseEnvelope(Buffer.from('{"event":"email.received","data":{"id":"legacy-mail"}}')),
    { event: 'email.received', data: { id: 'legacy-mail' } });
});

test('signed real-shaped delivery persists before ACK and resolves authoritative Markdown mail', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'second-key-live-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intake = new IntakeStore(directory);
  let enqueues = 0;
  const app = createApp({ secret, now: () => now, intake, eventTypePath: 'type', deliveryIdPath: 'id',
    enqueue: async event => {
      enqueues++;
      assert.equal(event.delivery_id, fixture.id);
      assert.ok(await intake.getByDeliveryId(fixture.id), 'delivery must be durable before enqueue');
    },
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/webhooks/ambiguous`;
  const conflicting = { ...fixture, event: 'task.completed', delivery_id: 'untrusted-legacy-id' };
  const requestBody = Buffer.from(JSON.stringify(conflicting));
  const response = await fetch(url, { method: 'POST', headers: headers(requestBody), body: requestBody });
  assert.equal(response.status, 200);
  await response.text();
  const jobs = await intake.list();
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.equal(job.deliveryId, fixture.id);
  assert.equal(job.event, 'email.received');
  assert.equal(job.receivedAt, now.toISOString());
  assert.deepEqual(job.data, conflicting);
  assert.equal(enqueues, 1);

  const authoritativeBody = '  Request Object Creator access for **thirty days**.\n';
  let lookups = 0;
  const options = {
    deliveryId: job.deliveryId, emailIdPath: 'resourceId', receivedAt: job.receivedAt,
    getEmail: async (id: string) => {
      lookups++;
      assert.equal(id, fixture.resourceId);
      return { id, body_text: null, body_markdown: authoritativeBody,
        from: { id: requester.id, email: requester.email }, thread_id: 'authoritative-thread',
        message_id: '<authoritative-message@example.test>', received_at: '1999-01-01T00:00:00Z' };
    },
    resolvePrincipal: (participant: { id?: unknown; email?: unknown }) =>
      participant.id === requester.id && participant.email === requester.email ? requester : null,
  };
  const normalized = await normalizeEmailEvent({ event: job.event, data: job.data }, options);
  assert.equal(lookups, 1);
  assert.equal(normalized.deliveryId, fixture.id);
  assert.equal(normalized.emailId, fixture.resourceId);
  assert.equal(normalized.text, authoritativeBody);
  assert.deepEqual(normalized.from, requester);
  assert.notEqual(normalized.from.id, fixture.actor.id);
  assert.notEqual(normalized.text, fixture.data.bodyFull);
  assert.equal(normalized.receivedAt, now.toISOString());
  assert.equal(normalized.threadId, 'authoritative-thread');

  await assert.rejects(normalizeEmailEvent({ event: job.event, data: job.data }, {
    ...options, getEmail: async () => ({ id: 'wrong-mail-id', body_markdown: authoritativeBody,
      from: { id: requester.id, email: requester.email } }),
  }), /Verified email lookup/);
  await assert.rejects(normalizeEmailEvent({ event: job.event, data: job.data }, {
    ...options, getEmail: async () => ({ id: fixture.resourceId, body_markdown: authoritativeBody,
      from: { id: fixture.actor.id, email: requester.email } }),
  }), /not a trusted principal/);

  const tampered = Buffer.from(JSON.stringify({ ...conflicting, id: 'evt_tampered', resourceId: 'tampered-mail' }));
  const bad = await fetch(url, { method: 'POST', headers: headers(requestBody), body: tampered });
  assert.equal(bad.status, 401);
  await bad.text();
  assert.equal((await intake.list()).length, 1);
  assert.equal(enqueues, 1);
});
