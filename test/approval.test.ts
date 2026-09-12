import assert from "node:assert/strict";
import test from "node:test";
import { findApprovalEvidence, isExplicitApproval } from "../src/approval.ts";
import type { TaskComment, TaskResult } from "../src/ambiguous/client.ts";

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
  const evidence = findApprovalEvidence({ recordId: "record-1", task, comments: [comment()], approver });
  assert.equal(evidence?.commentId, "comment-1");
  assert.equal(evidence?.actor.id, "alex");
  assert.equal(findApprovalEvidence({ recordId: "record-1", task: { ...task, assignee_id: "other" }, comments: [comment()], approver }), null);
  assert.equal(findApprovalEvidence({ recordId: "record-1", task: { ...task, status: "cancelled" }, comments: [comment()], approver }), null);
});

test("approval evidence searches replies and rejects missing attribution", () => {
  const reply = comment({ id: "comment-2", author: { id: "alex", display_name: null, primary_email: null } });
  const parent = comment({ content: "Review notes", author: null, replies: [reply] });
  assert.equal(findApprovalEvidence({ recordId: "record-1", task, comments: [parent], approver })?.commentId, "comment-2");
  assert.equal(findApprovalEvidence({ recordId: "record-1", task, comments: [comment({ author: { id: "other", display_name: null, primary_email: null } })], approver }), null);
  assert.equal(findApprovalEvidence({ recordId: "record-1", task, comments: [comment({ replies: [comment({ id: "comment-3" })] })], approver })?.commentId, "comment-1");
});
