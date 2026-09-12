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

test("racing acceptance across store instances has exactly one winner", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-intake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stores = [new IntakeStore(directory), new IntakeStore(directory)];
  const envelope = { event: "email.received", delivery_id: "racing", data: { id: "mail-1" } };
  const accepted = await Promise.all(Array.from({ length: 12 }, (_, i) => stores[i % 2]!.accept(envelope)));
  assert.equal(accepted.filter(result => !result.duplicate).length, 1);
  assert.equal((await stores[0]!.list()).length, 1);
});

test("intake rejects conflicting delivery reuse and payload mutation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-intake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const envelope = { event: "email.received", delivery_id: "immutable", data: { id: "mail-1", nested: { value: 1 } } };
  const { job } = await store.accept(envelope);
  await assert.rejects(store.accept({ ...envelope, data: { id: "mail-2" } }), /different content/);
  await assert.rejects(store.accept({ ...envelope, event: "task.assigned" }), /different content/);
  await assert.rejects(store.save({ ...job, data: {} }), /content cannot change/);
  assert.deepEqual((await store.get(job.id))?.data, envelope.data);
});

test("pending capacity is atomic, permits duplicates and frees completed jobs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-intake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory, { maxPendingJobs: 1 });
  const envelope = { event: "email.received", delivery_id: "first", data: {} };
  const results = await Promise.allSettled([store.accept(envelope), store.accept({ ...envelope, delivery_id: "second" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const [job] = await store.list();
  assert.ok(job);
  assert.equal((await store.accept(envelope)).duplicate, true);
  await store.save({ ...job, state: "complete" });
  assert.equal((await store.accept({ ...envelope, delivery_id: "second" })).duplicate, false);
});

test("duplicate lookup does not scan the intake directory", async t => {
  const directory = await mkdtemp(join(tmpdir(), "second-key-intake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new IntakeStore(directory);
  const envelope = { event: "email.received", delivery_id: "direct", data: {} };
  await store.accept(envelope);
  store.list = async () => { throw new Error("must not scan"); };
  assert.equal((await store.accept(envelope)).duplicate, true);
});
