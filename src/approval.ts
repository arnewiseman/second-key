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
}): ApprovalEvidence | null {
  if (input.task.status === "cancelled" || input.task.assignee_id !== input.approver.id) return null;
  for (const comment of flattenComments(input.comments)) {
    const author = comment.author;
    if (!author?.id || !matchesApprover(author.id, author.primary_email, input.approver)) continue;
    if (!comment.created_at || !isExplicitApproval(comment.content)) continue;
    return {
      recordId: input.recordId,
      taskId: input.task.id,
      commentId: comment.id,
      comment: comment.content,
      actor: { id: author.id, kind: "user", email: author.primary_email ?? "" },
      approvedAt: comment.created_at,
    };
  }
  return null;
}

/** Accepts only an unquoted, positive approval statement. */
export function isExplicitApproval(content: string): boolean {
  const text = content.split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join(" ").trim().toLowerCase();
  if (!text || /\b(?:reject|den(y|ied)|cancel|do not approve|don't approve|not approved)\b/.test(text)) return false;
  return /^(?:approve|approved|i approve|yes)(?:\b|[\s,.!:;-])/.test(text);
}

/** Flattens nested replies so approval does not depend on comment depth. */
function flattenComments(comments: TaskComment[]): TaskComment[] {
  return comments.flatMap(comment => [comment, ...flattenComments(comment.replies)]);
}

/** Matches an external comment author to the configured approver identity. */
function matchesApprover(id: string, email: string | null, approver: Principal): boolean {
  return id === approver.id || Boolean(email && email.trim().toLowerCase() === approver.email.trim().toLowerCase());
}
