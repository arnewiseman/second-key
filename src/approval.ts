import type { TaskComment, TaskResult } from "./ambiguous/client.ts";
import type { Principal } from "./types.ts";

export type ApprovalEvidence = {
  recordId: string;
  taskId: string;
  commentId: string;
  comment: string;
  actor: Principal;
  approvedAt: string;
};

/** Finds one attributable approval comment for the exact decision task. */
export function findApprovalEvidence(input: {
  recordId: string;
  task: TaskResult;
  comments: TaskComment[];
  approver: Principal;
  notBefore?: string;
  now?: string;
}): ApprovalEvidence | null {
  if (input.approver.kind !== "user" || !input.approver.id.trim() || !input.task.id.trim() ||
      !["todo", "in_progress", "done"].includes(input.task.status) ||
      input.task.assignee_id !== input.approver.id) return null;
  const notBefore = input.notBefore === undefined ? -Infinity : timestamp(input.notBefore);
  const now = timestamp(input.now ?? new Date().toISOString());
  if (Number.isNaN(notBefore) || Number.isNaN(now) || notBefore > now) return null;
  for (const comment of flattenComments(input.comments)) {
    const author = comment.author;
    if (author?.id !== input.approver.id || comment.task_id !== input.task.id || !comment.id.trim()) continue;
    const createdAt = timestamp(comment.created_at);
    if (!Number.isFinite(createdAt) || createdAt < notBefore || createdAt > now) continue;
    // An edited decision has no attributable decision-time history in this API.
    if (comment.updated_at !== null && timestamp(comment.updated_at) !== createdAt) continue;
    if (!isExplicitApproval(comment.content)) continue;
    return {
      recordId: input.recordId,
      taskId: input.task.id,
      commentId: comment.id,
      comment: comment.content,
      actor: { ...input.approver },
      approvedAt: comment.created_at!,
    };
  }
  return null;
}

/** Accepts only an unquoted, positive approval statement. */
export function isExplicitApproval(content: string): boolean {
  const text = content.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]$/, "");
  return new Set([
    "approve", "approved", "i approve", "i approve the proposed scope",
    "approved with the proposed scope", "approved with proposed scope",
    "approved. proceed with the proposed scope", "approved. proceed with proposed scope",
    "yes, proceed",
  ]).has(text);
}

/** Visit bounded nested replies without recursive stack growth or cycles. */
function* flattenComments(comments: TaskComment[]): Generator<TaskComment> {
  const limit = 10_000;
  const pending = comments.slice(0, limit).reverse();
  const seen = new Set<TaskComment>();
  let visited = 0;
  while (pending.length && visited < limit) {
    const comment = pending.pop()!;
    visited++;
    if (seen.has(comment)) continue;
    seen.add(comment);
    yield comment;
    const replies = comment.replies.slice(0, limit - visited - pending.length);
    for (let index = replies.length - 1; index >= 0; index--) pending.push(replies[index]!);
  }
}

/** Require an ISO timestamp with a real calendar date and explicit timezone. */
function timestamp(value: string | null): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || Number(value.slice(11, 13)) > 23) return NaN;
  return Date.parse(value);
}
