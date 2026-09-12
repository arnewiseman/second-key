import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntakeStore } from "../src/record/intake.ts";

test("intake store persists a delivery and deduplicates repeats", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-intake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const envelope = { event: "email.received", delivery_id: "delivery-1", data: { id: "mail-1" } };
  const receivedAt = new Date("2026-09-12T20:00:00.000Z");
  const first = await store.accept(envelope, receivedAt);
  const second = await store.accept(envelope, new Date("2026-09-12T20:01:00.000Z"));
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.job.receivedAt, receivedAt.toISOString());
  assert.deepEqual(await store.list(), [first.job]);
});

test("intake store rejects deliveries without an identity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-intake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(new IntakeStore(directory).accept({ event: "email.received", data: {} }), /delivery ID/);
});

test("intake store preserves updated processing state for recovery", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-intake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const { job } = await store.accept({ event: "email.received", delivery_id: "delivery-2", data: { id: "mail-2" } });
  const processing = { ...job, state: "processing" as const, attempts: 1 };
  await store.save(processing);
  assert.deepEqual(await store.get(job.id), processing);
});
