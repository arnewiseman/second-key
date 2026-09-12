import type { IntakeJob, IntakeStore } from "./intake.ts";

export type IntakeHandler = (job: IntakeJob) => Promise<void>;
const RECONCILIATION_REQUIRED = "reconciliation_required: Inspect external side effects before retrying intake";

/** Executes one durable job at a time; uncertain writes require explicit reconciliation. */
export class IntakeWorker {
  readonly #store: IntakeStore;
  readonly #handle: IntakeHandler;
  readonly #active = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(store: IntakeStore, handle: IntakeHandler) {
    this.#store = store;
    this.#handle = handle;
  }

  /** Recovers queued jobs and quarantines interrupted processing without repeating writes. */
  async recover(): Promise<void> {
    const jobs = await this.#store.list();
    const results = await Promise.allSettled(jobs
      .filter(job => job.state === "queued" || job.state === "processing")
      .map(job => this.submit(job)));
    if (results.some(result => result.status === "rejected")) throw new Error("Intake recovery encountered a job failure");
  }

  /** Enqueues one persisted job, discarding duplicate and stale submissions. */
  async submit(job: IntakeJob): Promise<void> {
    if (this.#active.has(job.id)) return;
    this.#active.add(job.id);
    const result = this.#tail.then(async () => {
      try {
        const current = await this.#store.get(job.id);
        if (!current || current.state === "complete" || current.state === "failed") return;
        if (current.state === "processing") {
          await this.#store.save({ ...current, state: "failed", lastError: RECONCILIATION_REQUIRED });
          return;
        }
        const processing = { ...current, state: "processing" as const, attempts: current.attempts + 1, lastError: null };
        await this.#store.save(processing);
        try {
          await this.#handle(structuredClone(processing));
          await this.#store.save({ ...processing, state: "complete" });
        } catch {
          await this.#store.save({ ...processing, state: "failed", lastError: RECONCILIATION_REQUIRED });
          throw new Error("Intake processing failed; reconciliation required");
        }
      } catch {
        // Upstream API and filesystem errors can contain credentials or request bodies.
        throw new Error("Intake job failed; inspect durable state before retrying");
      } finally {
        this.#active.delete(job.id);
      }
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  /** Waits for accepted in-process work before shutdown. */
  async drain(): Promise<void> {
    await this.#tail;
  }
}
