import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyze } from "../src/engine/index.ts";
import { createRouter } from "../src/router.ts";
import { RecordStore } from "../src/record/store.ts";
import type { Workspace } from "../src/ports.ts";

// Development contract check only: all artifacts stay local, no network calls.
const root = resolve("data/smoke");
await mkdir(root, { recursive: true });
const workspace: Workspace = {
  async createDocument(doc) {
    await writeFile(`${root}/analysis.md`, `# ${doc.title}\n\n${doc.content}\n`);
    return { url: `file://${root}/analysis.md` };
  },
  async createApprovalTask(task) {
    await writeFile(`${root}/task.json`, JSON.stringify(task, null, 2) + "\n");
    return { id: "local-stub-task" };
  },
  async sendRefusal(mail) { await writeFile(`${root}/refusal.json`, JSON.stringify(mail, null, 2) + "\n"); },
};
const router = createRouter({ analyze, workspace, records: new RecordStore(`${root}/records`),
  approver: { id: "alex-local", kind: "user", email: "alex@example.test" } });
const record = await router.receive({ text: await readFile("fixtures/inbound/01-pipeline.eml", "utf8"),
  from: { id: "priya-local", kind: "user", email: "priya.raman@example.test" } });
if (record.state !== "awaiting_approval" || !record.doc_url || !record.task_id) throw new Error("Smoke contract failed");
console.log(`Offline stub intake passed. Inspect ${root}/analysis.md, task.json and records/${record.id}.json`);
console.log("This is scaffold verification; parsing, live approvals and closeout remain owner tasks.");
