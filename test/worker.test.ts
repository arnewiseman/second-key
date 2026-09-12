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
  assert.equal((await store.get(job.id))?.lastError, "normalization failed");
  assert.equal((await store.get(job.id))?.state, "failed");
});
