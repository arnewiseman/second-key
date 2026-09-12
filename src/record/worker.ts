import type { IntakeJob, IntakeStore } from "./intake.ts";

export type IntakeHandler = (job: IntakeJob) => Promise<void>;

/** Runs persisted intake jobs with durable state transitions and per-delivery serialization. */
export class IntakeWorker {
  readonly #store: IntakeStore;
  readonly #handle: IntakeHandler;
  readonly #active = new Set<string>();

  constructor(store: IntakeStore, handle: IntakeHandler) {
    this.#store = store;
    this.#handle = handle;
  }

  /** Resumes queued and interrupted jobs after process startup. */
  async recover(): Promise<void> {
    const jobs = await this.#store.list();
    await Promise.all(jobs.filter(job => job.state === "queued" || job.state === "processing").map(job => this.submit(job)));
  }

  /** Processes one job once and records its terminal or retryable state. */
  async submit(job: IntakeJob): Promise<void> {
    if (this.#active.has(job.deliveryId)) return;
    this.#active.add(job.deliveryId);
    const processing = { ...job, state: "processing" as const, attempts: job.attempts + 1, lastError: null };
    await this.#store.save(processing);
    try {
      await this.#handle(processing);
      await this.#store.save({ ...processing, state: "complete" });
    } catch (error) {
      const lastError = error instanceof Error ? error.message : "Unknown intake processing error";
      await this.#store.save({ ...processing, state: "failed", lastError });
      throw error;
    } finally {
      this.#active.delete(job.deliveryId);
    }
  }
}
