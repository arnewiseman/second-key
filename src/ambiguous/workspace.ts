import type { Workspace } from "../ports.ts";
import type { Principal } from "../types.ts";
import { AmbiguousClient } from "./client.ts";

/** Adapts verified Ambiguous operations to the internal workspace contract. */
export class AmbiguousWorkspace implements Workspace {
  readonly #client: AmbiguousClient;

  constructor(client: AmbiguousClient) {
    this.#client = client;
  }

  /** Creates a Markdown document and returns its verified UI URL. */
  async createDocument(doc: { title: string; content: string }): Promise<{ url: string }> {
    const created = await this.#client.createDocument(doc);
    if (!created || typeof created.id !== "string" || !created.id.trim()) throw new Error("Invalid document response");
    return { url: this.#client.documentUrl(created.id) };
  }

  /** Creates an approval task for the configured human and links the document. */
  async createApprovalTask(task: { title: string; docUrl: string; approver: Principal }): Promise<{ id: string }> {
    if (task.approver.kind !== "user" || !task.approver.id.trim()) throw new Error("Approval task requires a human approver");
    const created = await this.#client.createTask({
      title: task.title,
      description: `Review the analysis document: ${task.docUrl}\n\nApprove the exact proposed scope by adding a fresh comment: Approved.`,
      assignee_id: task.approver.id,
    });
    if (!created || typeof created.id !== "string" || !created.id.trim() || created.assignee_id !== task.approver.id ||
        !["todo", "in_progress"].includes(created.status)) throw new Error("Approval task was not assigned as requested");
    return { id: created.id };
  }

  /** Sends a refusal email with a stable record-scoped idempotency key. */
  async sendRefusal(mail: { to: Principal; reason: string; recordId: string }): Promise<void> {
    const sent = await this.#client.sendMail({
      to: [mail.to.email],
      subject: "Access request refused",
      body_markdown: `Reeve refused this access request.\n\n${mail.reason}`,
    }, `${mail.recordId}:refusal`);
    if (!sent || typeof sent.id !== "string" || !sent.id.trim()) throw new Error("Invalid refusal mail response");
  }
}
