import assert from "node:assert/strict";
import test from "node:test";
import { findApprovalEvidence, isExplicitApproval } from "../src/approval.ts";
import type { TaskComment, TaskResult } from "../src/ambiguous/client.ts";

const now = "2026-09-12T21:00:00Z";
const approver = { id: "alex", kind: "user" as const, email: "alex@example.test" };
const task: TaskResult = { id: "task-1", title: "Approve", status: "done", assignee_id: "alex", completed_at: "2026-09-12T20:00:00Z" };

function comment(overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: "comment-1",
    task_id: "task-1",
    content: "Approved. Proceed with the proposed scope.",
    created_at: "2026-09-12T20:01:00Z",
    updated_at: null,
    author: { id: "alex", display_name: "Alex", primary_email: "alex@example.test" },
    replies: [],
    ...overrides,
  };
}

test("approval parser accepts explicit positive statements and rejects quoted or negative text", () => {
  for (const value of ["Approved.", "I approve the proposed scope.", "Yes, proceed."]) assert.equal(isExplicitApproval(value), true);
  for (const value of ["> Approved by Alex", "Do not approve this.", "I reject this.", "Looks good someday"]) assert.equal(isExplicitApproval(value), false);
});

test("approval evidence requires the assigned approver and exact task", () => {
  const evidence = findApprovalEvidence({ recordId: "record-1", now, task, comments: [comment()], approver });
  assert.equal(evidence?.commentId, "comment-1");
  assert.equal(evidence?.actor.id, "alex");
  assert.equal(findApprovalEvidence({ recordId: "record-1", now, task: { ...task, assignee_id: "other" }, comments: [comment()], approver }), null);
  assert.equal(findApprovalEvidence({ recordId: "record-1", now, task: { ...task, status: "cancelled" }, comments: [comment()], approver }), null);
});

test("approval evidence searches replies and rejects missing attribution", () => {
  const reply = comment({ id: "comment-2", author: { id: "alex", display_name: null, primary_email: null } });
  const parent = comment({ content: "Review notes", author: null, replies: [reply] });
  assert.equal(findApprovalEvidence({ recordId: "record-1", now, task, comments: [parent], approver })?.commentId, "comment-2");
  assert.equal(findApprovalEvidence({ recordId: "record-1", now, task, comments: [comment({ author: { id: "other", display_name: null, primary_email: null } })], approver }), null);
  assert.equal(findApprovalEvidence({ recordId: "record-1", now, task, comments: [comment({ replies: [comment({ id: "comment-3" })] })], approver })?.commentId, "comment-1");
});

test("approval parser rejects qualified, ambiguous, and quoted decisions", () => {
  for (const content of [
    "Yes, I reject", "Approved if the scope changes", "Approved?", "Approved, but only tomorrow",
    "Approved. Do not proceed.", "Yes", "I approve nothing", "> Approved.",
    "Approved.\n> only if the role changes", "Approved with a different scope",
  ]) assert.equal(isExplicitApproval(content), false, content);
  assert.equal(isExplicitApproval(" Approved. Proceed with the proposed scope. "), true);
});

test("approval cannot substitute matching email for trusted human identity", () => {
  const input = { recordId: "record-1", now, task, approver };
  const impostor = comment({ author: { id: "other", display_name: "Alex", primary_email: approver.email } });
  assert.equal(findApprovalEvidence({ ...input, comments: [impostor] }), null);
  assert.equal(findApprovalEvidence({ ...input, approver: { ...approver, kind: "service_account" }, comments: [comment()] }), null);
  const emailMismatch = comment({ author: { id: approver.id, display_name: null, primary_email: "untrusted@example.test" } });
  assert.deepEqual(findApprovalEvidence({ ...input, comments: [emailMismatch] })?.actor, approver);
});

test("approval requires exact comment task and a durable comment ID", () => {
  const input = { recordId: "record-1", now, task, approver };
  for (const value of [comment({ task_id: "another-task" }), comment({ id: " " }), comment({ id: "" })]) {
    assert.equal(findApprovalEvidence({ ...input, comments: [value] }), null);
  }
  assert.equal(findApprovalEvidence({ ...input, task: { ...task, status: "blocked" }, comments: [comment()] }), null);
});

test("approval timestamps must be valid, timely, and unedited", () => {
  const input = { recordId: "record-1", now, notBefore: "2026-09-12T20:00:00Z", task, approver };
  for (const value of [
    comment({ created_at: null }), comment({ created_at: "yesterday" }),
    comment({ created_at: "2026-02-30T20:01:00Z" }), comment({ created_at: "2026-09-12T20:01:00" }),
    comment({ created_at: "2026-09-12T19:59:59Z" }), comment({ created_at: "2026-09-12T21:00:01Z" }),
    comment({ updated_at: "2026-09-12T20:02:00Z" }), comment({ updated_at: "invalid" }),
  ]) assert.equal(findApprovalEvidence({ ...input, comments: [value] }), null, JSON.stringify(value));
  assert.equal(findApprovalEvidence({ ...input, comments: [comment({ updated_at: "2026-09-12T20:01:00Z" })] })?.commentId, "comment-1");
  assert.equal(findApprovalEvidence({ ...input, now: "invalid", comments: [comment()] }), null);
  assert.equal(findApprovalEvidence({ ...input, notBefore: "invalid", comments: [comment()] }), null);
});

test("approval traversal handles cycles and deep untrusted reply trees", () => {
  const parent = comment({ content: "Review notes" });
  parent.replies = [parent, comment({ id: "approval-reply" })];
  assert.equal(findApprovalEvidence({ recordId: "record-1", now, task, approver, comments: [parent] })?.commentId, "approval-reply");
  let deep = comment();
  for (let index = 0; index < 10_001; index++) deep = comment({ content: "Notes", replies: [deep] });
  assert.equal(findApprovalEvidence({ recordId: "record-1", now, task, approver, comments: [deep] }), null);
});
