import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloseout } from "../src/closeout.ts";
import { analyze } from "../src/engine/stub.ts";
import { RecordStore } from "../src/record/store.ts";
import type { AmbiguousClient, TaskComment, TaskResult } from "../src/ambiguous/client.ts";
import type { DecisionRecord } from "../src/types.ts";

const approver = { id: "alex", email: "alex@example.test", kind: "user" as const };
const requester = { id: "arne", email: "arne@example.test", kind: "user" as const };
const now = () => new Date("2026-09-12T21:00:00Z");
const window = { calendarId: "calendar-1", start: "2026-09-12T22:00:00Z", end: "2026-09-12T23:00:00Z" };
type Client = Pick<AmbiguousClient, "getTask" | "getTaskComments" | "createCalendarEvent" | "sendMail">;

function approval(overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: "comment-1", task_id: "task-1", content: "I approve the proposed scope.",
    author: { id: approver.id, display_name: "Alex", primary_email: approver.email },
    created_at: "2026-09-12T20:30:00Z", updated_at: null, replies: [], ...overrides,
  };
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "second-key-closeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  class FallibleStore extends RecordStore {
    failFinalSave = false;
    failApprovalSave = false;
    override async save(record: DecisionRecord) {
      if (this.failApprovalSave && record.approved_at !== null) {
        this.failApprovalSave = false;
        throw new Error("Injected approval record save failure");
      }
      if (this.failFinalSave && record.state === "approved") {
        this.failFinalSave = false;
        throw new Error("Injected final record save failure");
      }
      return super.save(record);
    }
  }
  const records = new FallibleStore(join(directory, "records"));
  const record: DecisionRecord = {
    id: "record-1", created_at: "2026-09-12T20:00:00Z",
    analysis: await analyze({ text: "Fixture request", from: requester }),
    doc_url: "https://example.test/docs/doc-1", task_id: "task-1", approver,
    approved_at: null, approval_comment: null, expires_at: null, state: "awaiting_approval",
    events: [{ at: "2026-09-12T20:05:00Z", actor: "reeve", what: "Approval task created for separate human" }],
  };
  await records.save(record);
  const calls: string[] = [];
  const pages: number[] = [];
  const calendarCalls: Parameters<Client["createCalendarEvent"]>[] = [];
  const mailCalls: Parameters<Client["sendMail"]>[] = [];
  const task: TaskResult = { id: "task-1", title: "Approve access", status: "done", assignee_id: approver.id, completed_at: "2026-09-12T20:30:00Z" };
  const client: Client = {
    async getTask(id) { assert.equal(id, "task-1"); calls.push("task"); return task; },
    async getTaskComments(id, page) {
      assert.equal(id, "task-1"); pages.push(page?.offset ?? 0);
      return { data: [approval()], total: 1, has_more: false };
    },
    async createCalendarEvent(...args) {
      calls.push("calendar"); calendarCalls.push(structuredClone(args));
      return { id: "event-1", title: args[1].title, calendar_id: args[0], start_at: args[1].start_at, end_at: args[1].end_at };
    },
    async sendMail(...args) {
      calls.push("mail"); mailCalls.push(structuredClone(args));
      return { id: "mail-1", read: false };
    },
  };
  const options = { records, client, approver, window, directory: join(directory, "closeout"), now };
  const journal = async () => JSON.parse(await readFile(join(options.directory, "record-1.json"), "utf8"));
  return { record, records, client, task, calls, pages, calendarCalls, mailCalls, options, journal };
}

test("attributable approval creates calendar then scoped mail and closes the audit record", async t => {
  const deps = await setup(t);
  await createCloseout(deps.options).close(deps.record.id);
  const stored = (await deps.records.get(deps.record.id))!;
  assert.deepEqual(deps.calls, ["task", "calendar", "mail"]);
  assert.equal(stored.state, "approved");
  assert.equal(stored.approved_at, approval().created_at);
  assert.equal(stored.approval_comment, approval().content);
  assert.equal(stored.expires_at, "2026-10-12T22:00:00.000Z");
  assert.match(stored.events.map(event => event.what).join("\n"), /actor=alex; task=task-1; comment=comment-1/);
  assert.match(stored.events.at(-1)!.what, /mail-1; closeout complete; no grant executed/);
  assert.deepEqual(deps.calendarCalls[0]![1].attendees, [approver.email, requester.email]);
  const [mail, key] = deps.mailCalls[0]!;
  assert.deepEqual(mail.to, [requester.email]);
  assert.equal(key, "record-1:decision");
  assert.match(mail.body_markdown, /roles\/storage.objectCreator/);
  assert.match(mail.body_markdown, /gs:\/\/prod-events-raw/);
  assert.match(mail.body_markdown, /2026-10-12T22:00:00.000Z/);
  assert.match(mail.body_markdown, /has not executed an IAM grant/);
  assert.equal((await deps.journal()).mail, "complete");
});

test("task completion without attributable approval cannot trigger closeout", async t => {
  for (const scenario of ["wrong actor", "wrong comment task", "no comment", "cancelled", "wrong returned task"] as const) {
    await t.test(scenario, async child => {
      const deps = await setup(child);
      const comments = scenario === "no comment" ? [] : [approval({
        ...(scenario === "wrong actor" ? { author: { id: "mallory", display_name: "Alex", primary_email: approver.email } } : {}),
        ...(scenario === "wrong comment task" ? { task_id: "unrelated" } : {}),
      })];
      deps.client.getTaskComments = async () => ({ data: comments, total: comments.length, has_more: false });
      if (scenario === "cancelled") deps.task.status = "cancelled";
      if (scenario === "wrong returned task") deps.task.id = "unrelated";
      const result = createCloseout(deps.options).close(deps.record.id);
      if (scenario === "wrong returned task") await assert.rejects(result, /does not match/);
      else await result;
      assert.equal((await deps.records.get(deps.record.id))!.state, "awaiting_approval");
      assert.equal(deps.calendarCalls.length, 0);
      assert.equal(deps.mailCalls.length, 0);
    });
  }
});

test("closeout exhausts comment pagination and finds approval on a later page", async t => {
  const deps = await setup(t);
  deps.client.getTaskComments = async (_id, page) => {
    deps.pages.push(page?.offset ?? 0);
    return page?.offset === 0
      ? { data: [approval({ content: "Review notes" })], total: 2, has_more: true }
      : { data: [approval()], total: 2, has_more: false };
  };
  await createCloseout(deps.options).close(deps.record.id);
  assert.deepEqual(deps.pages, [0, 1]);
  assert.equal((await deps.records.get(deps.record.id))!.state, "approved");
});

test("an incomplete comment page blocks approval even after a positive comment", async t => {
  const deps = await setup(t);
  deps.client.getTaskComments = async (_id, page) => page?.offset === 0
    ? { data: [approval()], total: 2, has_more: true }
    : { data: [], total: 2, has_more: true };
  await assert.rejects(createCloseout(deps.options).close(deps.record.id), /pagination did not advance/);
  assert.equal(deps.calendarCalls.length, 0);
  assert.equal(deps.mailCalls.length, 0);
});

test("concurrent and repeated closeouts do not duplicate external effects", async t => {
  const deps = await setup(t);
  const closeout = createCloseout(deps.options);
  await Promise.all(Array.from({ length: 8 }, () => closeout.close(deps.record.id)));
  await closeout.close(deps.record.id);
  await createCloseout(deps.options).close(deps.record.id);
  assert.equal(deps.calendarCalls.length, 1);
  assert.equal(deps.mailCalls.length, 1);
});

test("uncertain calendar outcome is durable and never blindly retried after restart", async t => {
  const deps = await setup(t);
  let attempts = 0;
  deps.client.createCalendarEvent = async () => { attempts++; throw new Error("Timeout after remote write"); };
  const closeout = createCloseout(deps.options);
  await assert.rejects(closeout.close(deps.record.id), /requires reconciliation/);
  assert.equal((await deps.journal()).calendar, "pending");
  await closeout.close(deps.record.id);
  await createCloseout(deps.options).close(deps.record.id);
  assert.equal(attempts, 1);
  assert.equal(deps.mailCalls.length, 0);
  const record = (await deps.records.get(deps.record.id))!;
  assert.equal(record.state, "awaiting_approval");
  assert.match(record.events.at(-1)!.what, /Calendar outcome unknown/);
});

test("mail retry after the booked window preserves exact payload and key without recreating the calendar", async t => {
  const deps = await setup(t);
  const sendMail = deps.client.sendMail;
  let attempts = 0;
  deps.client.sendMail = async (...args) => {
    const response = await sendMail(...args);
    if (++attempts === 1) throw new Error("Mail response lost");
    return response;
  };
  await assert.rejects(createCloseout(deps.options).close(deps.record.id), /email remains pending/);
  assert.equal((await deps.journal()).mail, "pending");
  await createCloseout({
    ...deps.options,
    now: () => new Date("2026-09-13T21:00:00Z"),
    window: { ...window, start: "2026-09-13T22:00:00Z", end: "2026-09-13T23:00:00Z" },
  }).close(deps.record.id);
  assert.equal(deps.calendarCalls.length, 1);
  assert.equal(deps.mailCalls.length, 2);
  assert.deepEqual(deps.mailCalls[1], deps.mailCalls[0]);
  assert.equal((await deps.records.get(deps.record.id))!.state, "approved");
});

test("restart cannot create a past calendar window after approval record persistence fails", async t => {
  const deps = await setup(t);
  deps.records.failApprovalSave = true;
  await assert.rejects(createCloseout(deps.options).close(deps.record.id), /approval record save failure/);
  assert.equal((await deps.journal()).calendar, null);
  assert.equal((await deps.records.get(deps.record.id))!.approved_at, null);
  const restarted = createCloseout({ ...deps.options, now: () => new Date("2026-09-12T22:01:00Z") });
  await assert.rejects(restarted.close(deps.record.id), /saved change window has passed/);
  assert.equal((await deps.journal()).calendar, null);
  assert.equal(deps.calendarCalls.length, 0);
  assert.equal(deps.mailCalls.length, 0);
  assert.equal((await deps.records.get(deps.record.id))!.state, "awaiting_approval");
});

test("restart recovers final record save failure without repeating successful mail", async t => {
  const deps = await setup(t);
  deps.records.failFinalSave = true;
  await assert.rejects(createCloseout(deps.options).close(deps.record.id), /final record save failure/);
  assert.equal((await deps.records.get(deps.record.id))!.state, "awaiting_approval");
  assert.equal((await deps.journal()).mail, "complete");
  await createCloseout(deps.options).close(deps.record.id);
  assert.equal((await deps.records.get(deps.record.id))!.state, "approved");
  assert.equal(deps.calendarCalls.length, 1);
  assert.equal(deps.mailCalls.length, 1);
});
