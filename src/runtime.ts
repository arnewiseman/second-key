import { join } from "node:path";
import type { Principal } from "./types.ts";
import type { Analyze } from "./ports.ts";
import { createRouter } from "./router.ts";
import { RecordStore } from "./record/store.ts";
import { IntakeStore } from "./record/intake.ts";
import { IntakeWorker } from "./record/worker.ts";
import { createIntakeHandler } from "./record/processor.ts";
import { AmbiguousClient } from "./ambiguous/client.ts";
import { AmbiguousWorkspace } from "./ambiguous/workspace.ts";
import { createCloseout } from "./closeout.ts";
import type { ChangeWindow } from "./closeout.ts";

/** One process, one worker, one non-overlapping three-second polling loop. */
export function createRuntime(options: {
  client: AmbiguousClient; analyze: Analyze; approver: Principal; requester: Principal;
  recordDir: string; window: ChangeWindow; emailIdPath: string; now?: () => Date;
  log?: (event: string) => void;
}) {
  const records = new RecordStore(options.recordDir);
  const intake = new IntakeStore(join(options.recordDir, "intake"));
  const workspace = new AmbiguousWorkspace(options.client);
  const router = createRouter({ analyze: options.analyze, workspace, records, approver: options.approver, now: options.now });
  const worker = new IntakeWorker(intake, createIntakeHandler({ router, emailIdPath: options.emailIdPath,
    getEmail: id => options.client.getEmail(id), resolvePrincipal: participant =>
      participant.id === options.requester.id && typeof participant.email === "string" &&
      participant.email.toLowerCase() === options.requester.email.toLowerCase() ? { ...options.requester } : null,
  }));
  const closeout = createCloseout({ records, client: options.client, approver: options.approver,
    window: options.window, directory: join(options.recordDir, "closeout"), now: options.now });
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let recovered = false;
  const log = options.log ?? (event => console.info(JSON.stringify({ service: "reeve", event })));
  async function process() {
    if (!recovered) {
      recovered = true;
      try { await worker.recover(); } catch { log("intake_recovery_requires_review"); }
    } else {
      for (const job of await intake.list()) if (job.state === "queued") {
        try { await worker.submit(job); } catch { log("intake_job_failed_review_required"); }
      }
    }
    for (const record of await records.list()) if (record.state === "awaiting_approval") {
      try { await closeout.close(record.id); } catch { log("closeout_pending_review_or_retry"); }
    }
  }
  function tick(): Promise<void> {
    pending ??= process().finally(() => { pending = undefined; });
    return pending;
  }
  return { records, intake, tick,
    // HTTP has already persisted the job. Model and workspace calls run on the timer.
    enqueue: async () => {},
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick().catch(() => log("runtime_tick_failed")); }, 3000);
      void tick().catch(() => log("runtime_tick_failed"));
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await pending?.catch(() => {});
      await worker.drain();
    },
  };
}
