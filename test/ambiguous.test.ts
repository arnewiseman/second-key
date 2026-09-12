import assert from 'node:assert/strict';
import test from 'node:test';
import { AmbiguousApiError, AmbiguousClient, type RequestLog } from '../src/ambiguous/client.ts';
import { renderDoc } from '../src/ambiguous/render.ts';
import { AmbiguousWorkspace } from '../src/ambiguous/workspace.ts';

function clientWith(fetch: typeof globalThis.fetch, extra = {}) {
  return new AmbiguousClient({ baseUrl: 'https://app.ambiguous.ai', agentKey: 'ak_private-test-key', fetch, log: () => {}, ...extra });
}

test('uses verified document Markdown shape, flat response, agent identity and UI URL', async () => {
  const client = clientWith(async (url, init) => {
    assert.equal(String(url), 'https://app.ambiguous.ai/api/documents');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ak_private-test-key');
    assert.equal(new Headers(init?.headers).get('API-Version'), '1');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), { type: 'doc', title: 'Review', content: '# Exact\n\nBody' });
    return Response.json({ id: 'doc-1', title: 'Review', type: 'doc' }, { status: 201 });
  });
  const doc = await client.createDocument({ title: 'Review', content: renderDoc('# Exact\n\nBody') });
  assert.equal(doc.id, 'doc-1');
  assert.equal(client.documentUrl(doc.id), 'https://app.ambiguous.ai/docs/doc-1');
});

test('retries GET 429 respecting Retry-After, unwraps task, and logs only metadata', async () => {
  let calls = 0;
  const logs: RequestLog[] = [];
  const delays: number[] = [];
  const client = clientWith(async () => {
    if (++calls === 1) return new Response('secret response body', { status: 429, headers: { 'Retry-After': '1' } });
    return Response.json({ task: { id: 'task-1', title: 'Sensitive request', status: 'todo', assignee_id: 'alex', completed_at: null } });
  }, { log: (entry: RequestLog) => logs.push(entry), sleep: async (ms: number) => { delays.push(ms); } });
  const task = await client.getTask('secret-id');
  assert.equal(task.id, 'task-1');
  assert.deepEqual(delays, [1000]);
  assert.equal(calls, 2);
  assert.equal(logs.length, 2);
  assert.doesNotMatch(JSON.stringify(logs), /ak_private|secret|Sensitive|Authorization/);
  assert.deepEqual(Object.keys(logs[0]!).sort(), ['service', 'operation', 'method', 'attempt', 'status', 'duration_ms'].sort());
});

test('document, task and calendar POSTs are never automatically retried', async () => {
  for (const operation of ['document', 'task', 'calendar']) {
    let calls = 0;
    const client = clientWith(async () => { calls++; return new Response('private failure', { status: 503 }); });
    const promise = operation === 'document' ? client.createDocument({ title: 'Doc', content: 'Body' }) :
      operation === 'task' ? client.createTask({ title: 'Task', assignee_id: 'alex' }) :
        client.createCalendarEvent('calendar', { title: 'Window', start_at: '2026-09-14T09:00:00Z', end_at: '2026-09-14T09:30:00Z' });
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof AmbiguousApiError);
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /private failure/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('mail safely retries with the same idempotency key and identical send parameters', async () => {
  const seen: { key: string | null; body: string }[] = [];
  const client = clientWith(async (url, init) => {
    assert.equal(String(url), 'https://app.ambiguous.ai/api/mail/send');
    seen.push({ key: new Headers(init?.headers).get('Idempotency-Key'), body: String(init?.body) });
    if (seen.length === 1) throw new Error('network error including ak_private-test-key');
    return Response.json({ id: 'mail-1', read: false }, { status: 201 });
  }, { sleep: async () => {} });
  await client.sendMail({ to: ['requester@example.com'], subject: 'Decision', body_markdown: 'Approved by Alex' }, 'record-1:decision');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[0]!.key, 'record-1:decision');
  assert.throws(() => client.sendMail({ to: ['a@example.com'], subject: 'x', body_markdown: 'x' }, ''), /idempotency/);
});

test('does not retry authorization errors or ambiguous successful response decoding', async () => {
  for (const status of [401, 201]) {
    let calls = 0;
    const client = clientWith(async () => { calls++; return new Response('body not JSON', { status }); });
    await assert.rejects(client.getTask('id'), AmbiguousApiError);
    assert.equal(calls, 1);
  }
});

test('times out a stalled request and redacts the underlying transport error', async () => {
  const client = clientWith(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('private network details')), { once: true });
  }), { timeoutMs: 10, maxRetries: 0 });
  await assert.rejects(client.getEmail('id'), (error: unknown) => {
    assert.ok(error instanceof AmbiguousApiError);
    assert.equal(error.status, null);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});

test('uses exact task/comment/calendar endpoints and documented envelopes', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = clientWith(async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).endsWith('/api/tasks')) return Response.json({ task: { id: 'task-1' } }, { status: 201 });
    if (String(url).includes('/comments')) return Response.json({ data: [], total: 0, has_more: false });
    return Response.json({ id: 'event-1' }, { status: 201 });
  });
  assert.equal((await client.createTask({ title: 'Approve scoped change', assignee_id: 'alex' })).id, 'task-1');
  assert.deepEqual(await client.getTaskComments('task/1', { limit: 100, offset: 0 }), { data: [], total: 0, has_more: false });
  const event = { title: 'Approved change window', start_at: '2026-09-14T09:00:00Z', end_at: '2026-09-14T09:30:00Z' };
  assert.equal((await client.createCalendarEvent('cal/1', event)).id, 'event-1');
  assert.equal(calls[1]!.url, 'https://app.ambiguous.ai/api/tasks/task%2F1/comments?limit=100&offset=0');
  assert.equal(calls[2]!.url, 'https://app.ambiguous.ai/api/calendars/cal%2F1/events');
  assert.deepEqual(calls[2]!.body, event);
});

test('refuses remote cleartext URLs and invalid retry configuration', () => {
  assert.throws(() => new AmbiguousClient({ baseUrl: 'http://example.com', agentKey: 'key' }), /HTTPS/);
  assert.throws(() => new AmbiguousClient({ baseUrl: 'https://app.ambiguous.ai', agentKey: 'key', maxRetries: -1 }), /configuration/);
});

test('workspace adapter maps documents, approval tasks, and refusal mail', async () => {
  const calls: { url: string; body: unknown; key: string | null }[] = [];
  const client = clientWith(async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get('Idempotency-Key') });
    if (String(url).endsWith('/api/documents')) return Response.json({ id: 'doc-1', title: 'Review', type: 'doc' }, { status: 201 });
    if (String(url).endsWith('/api/tasks')) return Response.json({ task: { id: 'task-1', title: 'Review', status: 'todo', assignee_id: 'alex', completed_at: null } }, { status: 201 });
    return Response.json({ id: 'mail-1', read: false }, { status: 201 });
  });
  const workspace = new AmbiguousWorkspace(client);
  const doc = await workspace.createDocument({ title: 'Review', content: '# Review' });
  const task = await workspace.createApprovalTask({ title: 'Approve request', docUrl: doc.url, approver: { id: 'alex', kind: 'user', email: 'alex@example.test' } });
  await workspace.sendRefusal({ to: { id: 'arne', kind: 'user', email: 'arne@example.test' }, reason: 'NO-BASIC-ROLES', recordId: 'record-1' });
  assert.equal(doc.url, 'https://app.ambiguous.ai/docs/doc-1');
  assert.equal(task.id, 'task-1');
  assert.equal(calls[1]!.body && (calls[1]!.body as { assignee_id: string }).assignee_id, 'alex');
  assert.equal(calls[2]!.key, 'record-1:refusal');
});

test('workspace refuses missing external IDs and incorrect task assignment', async () => {
  const bad = new AmbiguousWorkspace(clientWith(async () => Response.json({})));
  await assert.rejects(bad.createDocument({ title: 'x', content: 'x' }), /document response/);
  await assert.rejects(bad.sendRefusal({ to: { id: 'user', kind: 'user', email: 'user@example.test' }, reason: 'blocked', recordId: 'r' }), /mail response/);
  const wrongTask = new AmbiguousWorkspace(clientWith(async () => Response.json({ task: { id: 't', status: 'todo', assignee_id: 'other' } })));
  await assert.rejects(wrongTask.createApprovalTask({ title: 'Approve', docUrl: 'https://example.test/d', approver: { id: 'alex', kind: 'user', email: 'alex@example.test' } }), /not assigned/);
});
