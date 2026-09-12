import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AmbiguousClient, TaskComment } from "./ambiguous/client.ts";
import { findApprovalEvidence } from "./approval.ts";
import type { ApprovalEvidence } from "./approval.ts";
import type { DecisionRecord, Principal } from "./types.ts";
import type { RecordStore } from "./record/store.ts";

export type ChangeWindow = { calendarId: string; start: string; end: string };
type Progress = {
  recordId: string; evidence: ApprovalEvidence; window: ChangeWindow; expiresAt: string;
  calendar: "pending" | "complete" | null; calendarEventId: string | null;
  mail: "pending" | "complete" | null; mailId: string | null;
};
type Client = Pick<AmbiguousClient, "getTask" | "getTaskComments" | "createCalendarEvent" | "sendMail">;

/** Durable operation intents prevent blind replay of non-idempotent calendar writes. */
export function createCloseout(options: {
  records: RecordStore; client: Client; approver: Principal; window: ChangeWindow;
  directory: string; now?: () => Date;
}) {
  const active = new Map<string, Promise<void>>();
  const timestamp = () => (options.now?.() ?? new Date()).toISOString();
  const path = (id: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid closeout record id");
    return join(options.directory, `${id}.json`);
  };
  async function load(id: string): Promise<Progress | null> {
    try { return JSON.parse(await readFile(path(id), "utf8")) as Progress; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async function save(progress: Progress) {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path(progress.recordId)}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(progress, null, 2) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path(progress.recordId));
      const directory = await open(options.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async function update(record: DecisionRecord, patch: Partial<DecisionRecord>, what: string) {
    Object.assign(record, patch);
    record.events = [...record.events, { at: timestamp(), actor: "reeve", what }];
    await options.records.save(record);
  }
  async function comments(taskId: string): Promise<TaskComment[]> {
    const all: TaskComment[] = [];
    for (let offset = 0; offset < 10_000;) {
      const page = await options.client.getTaskComments(taskId, { limit: 100, offset });
      if (!page || !Array.isArray(page.data) || typeof page.has_more !== "boolean") throw new Error("Invalid task comments response");
      all.push(...page.data);
      if (!page.has_more) return all;
      if (!page.data.length) throw new Error("Task comments pagination did not advance");
      offset += page.data.length;
    }
    throw new Error("Task comments exceed review limit");
  }
  async function run(id: string) {
    const record = await options.records.get(id);
    if (!record || record.state !== "awaiting_approval") return;
    const recommendation = record.analysis.recommendation;
    if (record.analysis.refused || !recommendation || !record.task_id || !record.doc_url ||
        !record.approver || record.approver.id !== options.approver.id || record.approver.email !== options.approver.email ||
        options.approver.kind !== "user" || record.analysis.request.requester.id === options.approver.id ||
        record.analysis.request.requester.email.toLowerCase() === options.approver.email.toLowerCase()) throw new Error("Invalid approval record");
    let progress = await load(id);
    if (!progress) {
      const task = await options.client.getTask(record.task_id);
      if (!task || task.id !== record.task_id) throw new Error("Task does not match the decision record");
      const taskCreated = record.events.find(event => event.what === "Approval task created for separate human")?.at ?? record.created_at;
      const evidence = findApprovalEvidence({ recordId: id, task, comments: await comments(task.id),
        approver: options.approver, notBefore: taskCreated, now: timestamp() });
      if (!evidence) return;
      const window = { ...options.window };
      const start = Date.parse(window.start), end = Date.parse(window.end);
      if (!window.calendarId.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
          start < Date.parse(evidence.approvedAt) || start < Date.parse(timestamp()) || !Number.isSafeInteger(recommendation.duration_days) || recommendation.duration_days <= 0) {
        throw new Error("A valid future change window is required");
      }
      progress = { recordId: id, evidence, window,
        expiresAt: new Date(start + recommendation.duration_days * 86_400_000).toISOString(),
        calendar: null, calendarEventId: null, mail: null, mailId: null };
      await save(progress);
    }
    if (progress.recordId !== id || progress.evidence.taskId !== record.task_id || progress.evidence.actor.id !== options.approver.id) {
      throw new Error("Closeout journal does not match the record");
    }
    if (!record.approved_at) await update(record, { approved_at: progress.evidence.approvedAt,
      approval_comment: progress.evidence.comment, expires_at: progress.expiresAt },
      `Human approval recorded: actor=${progress.evidence.actor.id}; task=${progress.evidence.taskId}; comment=${progress.evidence.commentId}`);
    if (progress.calendar === "pending") return; // Ambiguous prior attempt: requires explicit reconciliation.
    if (progress.calendar === null) {
      if (Date.parse(progress.window.start) < Date.parse(timestamp())) throw new Error("The saved change window has passed; review is required");
      progress.calendar = "pending";
      await save(progress);
      try {
        const event = await options.client.createCalendarEvent(progress.window.calendarId, {
          title: `Approved access change: ${record.analysis.request.resource}`,
          start_at: progress.window.start, end_at: progress.window.end,
          description: `${record.analysis.decision_required}\nAnalysis: ${record.doc_url}\nExpiry: ${progress.expiresAt}\nHuman execution is required; Reeve has not granted access.`,
          attendees: [options.approver.email, record.analysis.request.requester.email],
        });
        if (!event?.id?.trim() || event.calendar_id !== progress.window.calendarId) throw new Error("Invalid calendar result");
        progress.calendarEventId = event.id;
        progress.calendar = "complete";
        await save(progress);
      } catch {
        await update(record, {}, "Calendar outcome unknown; reconcile closeout journal before replay");
        throw new Error("Calendar outcome requires reconciliation");
      }
    }
    const calendarNote = `Calendar event created: ${progress.calendarEventId}`;
    if (!record.events.some(event => event.what === calendarNote)) await update(record, {}, calendarNote);
    if (progress.mail !== "complete") {
      progress.mail = "pending";
      await save(progress);
      try {
        const mail = await options.client.sendMail({ to: [record.analysis.request.requester.email],
          subject: "Access request approved for human execution",
          body_markdown: `Approved by ${progress.evidence.actor.email}.\n\nRole: ${recommendation.role}\nResource: ${record.analysis.request.resource}\nGrantee: ${record.analysis.request.requester.email}\nChange window: ${progress.window.start} to ${progress.window.end}\nExpiry: ${progress.expiresAt}\nAnalysis: ${record.doc_url}\n\nReeve has not executed an IAM grant. A human must perform the approved change.`,
        }, `${record.id}:decision`);
        if (!mail?.id?.trim()) throw new Error("Invalid mail result");
        progress.mailId = mail.id;
        progress.mail = "complete";
        await save(progress);
      } catch {
        const note = "Decision email pending; retry with the same idempotency key";
        if (record.events.at(-1)?.what !== note) await update(record, {}, note);
        throw new Error("Decision email remains pending");
      }
    }
    await update(record, { state: "approved" }, `Decision email sent: ${progress.mailId}; closeout complete; no grant executed`);
  }
  return {
    close(id: string): Promise<void> {
      const existing = active.get(id);
      if (existing) return existing;
      const promise = run(id).finally(() => active.delete(id));
      active.set(id, promise);
      return promise;
    },
  };
}
