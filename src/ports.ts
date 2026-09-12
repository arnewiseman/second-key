import type { Analysis, Principal } from "./types.ts";

export type Analyze = (inbound: { text: string; from: Principal }) => Promise<Analysis>;

/** Internal application contracts, not Ambiguous API payloads. Alex owns adapters. */
export interface Workspace {
  createDocument(doc: { title: string; content: string }): Promise<{ url: string }>;
  createApprovalTask(task: { title: string; docUrl: string; approver: Principal }): Promise<{ id: string }>;
  sendRefusal(mail: { to: Principal; reason: string; recordId: string }): Promise<void>;
}
