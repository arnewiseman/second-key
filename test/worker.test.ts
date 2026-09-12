import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntakeStore } from "../src/record/intake.ts";
import { IntakeWorker } from "../src/record/worker.ts";

test("worker recovers queued jobs and records completion", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const { job } = await store.accept({ event: "email.received", delivery_id: "delivery-1", data: { id: "mail-1" } });
  const seen: string[] = [];
  const worker = new IntakeWorker(store, async input => { seen.push(input.deliveryId); });
  await worker.recover();
  assert.deepEqual(seen, ["delivery-1"]);
  assert.equal((await store.get(job.id))?.state, "complete");
  assert.equal((await store.get(job.id))?.attempts, 1);
});

test("worker serializes duplicate submissions and records failures", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const { job } = await store.accept({ event: "email.received", delivery_id: "delivery-2", data: { id: "mail-2" } });
  let active = 0;
  let maximumActive = 0;
  const worker = new IntakeWorker(store, async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    throw new Error("normalization failed");
  });
  const results = await Promise.allSettled([worker.submit(job), worker.submit(job)]);
  assert.equal(maximumActive, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.match((await store.get(job.id))?.lastError ?? "", /^reconciliation_required:/);
  assert.equal((await store.get(job.id))?.state, "failed");
});

test("worker bounds different jobs globally and skips stale terminal jobs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const jobs = await Promise.all(["one", "two", "three"].map(async delivery_id =>
    (await store.accept({ event: "email.received", delivery_id, data: {} })).job));
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const worker = new IntakeWorker(store, async () => {
    calls++;
    maximumActive = Math.max(maximumActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  });
  const work = jobs.map(job => worker.submit(job));
  await worker.drain();
  await Promise.all(work);
  await Promise.all(jobs.map(job => worker.submit(job)));
  assert.equal(maximumActive, 1);
  assert.equal(calls, 3);
});

test("restart quarantines interrupted work, recovers queued work, and does not retry failed jobs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const interrupted = (await store.accept({ event: "email.received", delivery_id: "interrupted", data: {} })).job;
  const queued = (await store.accept({ event: "email.received", delivery_id: "queued", data: {} })).job;
  await store.save({ ...interrupted, state: "processing", attempts: 1 });
  const seen: string[] = [];
  const worker = new IntakeWorker(new IntakeStore(directory), async job => { seen.push(job.deliveryId); });
  await worker.recover();
  await worker.submit(interrupted);
  await worker.recover();
  assert.deepEqual(seen, [queued.deliveryId]);
  const recovered = await store.get(interrupted.id);
  assert.equal(recovered?.state, "failed");
  assert.equal(recovered?.attempts, 1);
  assert.match(recovered?.lastError ?? "", /^reconciliation_required:/);
});

test("initial persistence failure releases the active slot and does not block independent jobs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const first = (await store.accept({ event: "email.received", delivery_id: "first", data: {} })).job;
  const second = (await store.accept({ event: "email.received", delivery_id: "second", data: {} })).job;
  const save = store.save.bind(store);
  let failOnce = true;
  store.save = async job => {
    if (job.id === first.id && failOnce) {
      failOnce = false;
      throw new Error("sensitive upstream error");
    }
    return save(job);
  };
  const seen: string[] = [];
  const worker = new IntakeWorker(store, async job => { seen.push(job.deliveryId); });
  const results = await Promise.allSettled([worker.submit(first), worker.submit(second)]);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "fulfilled");
  assert.equal((await store.get(first.id))?.state, "queued");
  await worker.recover();
  assert.deepEqual(seen, ["second", "first"]);
});

test("handler failure is redacted, continues recovery, and cannot be replayed with a stale job", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const failed = (await store.accept({ event: "email.received", delivery_id: "failed", data: {} })).job;
  const good = (await store.accept({ event: "email.received", delivery_id: "good", data: {} })).job;
  const seen: string[] = [];
  const worker = new IntakeWorker(store, async job => {
    seen.push(job.deliveryId);
    if (job.id === failed.id) throw new Error("sensitive upstream error");
  });
  await assert.rejects(worker.recover(), /recovery encountered a job failure/);
  await worker.submit(failed);
  assert.equal((await store.get(good.id))?.state, "complete");
  const state = await store.get(failed.id);
  assert.match(state?.lastError ?? "", /^reconciliation_required:/);
  assert.equal(JSON.stringify(state).includes("sensitive upstream error"), false);
  assert.equal(seen.filter(id => id === "failed").length, 1);
});
