import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { WebhookEnvelope } from "../webhook.ts";

export type IntakeJobState = "queued" | "processing" | "complete" | "failed";

export type IntakeJob = {
  id: string;
  deliveryId: string;
  event: string;
  data: unknown;
  receivedAt: string;
  state: IntakeJobState;
  attempts: number;
  lastError: string | null;
};

export type AcceptedIntake = { job: IntakeJob; duplicate: boolean };
const directoryWrites = new Map<string, Promise<void>>();

/** Stores authenticated webhook deliveries before worker processing starts. One service process owns the directory. */
export class IntakeStore {
  readonly directory: string;
  readonly #maxPendingJobs: number;

  constructor(directory: string, options: { maxPendingJobs?: number } = {}) {
    this.directory = resolve(directory);
    this.#maxPendingJobs = options.maxPendingJobs ?? 100;
    if (!Number.isSafeInteger(this.#maxPendingJobs) || this.#maxPendingJobs < 1) {
      throw new Error("Intake pending limit must be a positive integer");
    }
  }

  /** Atomically accepts a delivery; conflicting reuse of an identity is rejected. */
  async accept(envelope: WebhookEnvelope, receivedAt: Date = new Date()): Promise<AcceptedIntake> {
    const deliveryId = envelope.delivery_id?.trim();
    if (!deliveryId) throw new Error("Webhook delivery ID is required");
    const event = envelope.event;
    const data: unknown = JSON.parse(JSON.stringify(envelope.data));
    return this.serialize(async () => {
      const existing = await this.getByDeliveryId(deliveryId);
      if (existing) {
        if (existing.event !== event || !isDeepStrictEqual(existing.data, data)) {
          throw new Error("Webhook delivery ID was reused with different content");
        }
        return { job: existing, duplicate: true };
      }
      const pending = (await this.list()).filter(job => job.state === "queued" || job.state === "processing");
      if (pending.length >= this.#maxPendingJobs) throw new Error("Intake pending capacity reached");
      const job: IntakeJob = {
        id: createJobId(deliveryId), deliveryId, event, data,
        receivedAt: receivedAt.toISOString(), state: "queued", attempts: 0, lastError: null,
      };
      await this.saveUnlocked(job);
      return { job, duplicate: false };
    });
  }

  /** Reads the delivery's deterministic filename without scanning historical jobs. */
  async getByDeliveryId(deliveryId: string): Promise<IntakeJob | null> {
    const id = deliveryId.trim();
    return id ? this.get(createJobId(id)) : null;
  }

  /** Saves a snapshot while preserving the original delivery and payload. */
  async save(job: IntakeJob): Promise<void> {
    const snapshot = structuredClone(job);
    await this.serialize(() => this.saveUnlocked(snapshot));
  }

  private async saveUnlocked(job: IntakeJob): Promise<void> {
    const target = this.path(job.id);
    if (job.id !== createJobId(job.deliveryId)) throw new Error("Intake delivery identity cannot change");
    const previous = await this.get(job.id);
    if (previous && (previous.deliveryId !== job.deliveryId || previous.event !== job.event
      || previous.receivedAt !== job.receivedAt || !isDeepStrictEqual(previous.data, job.data))) {
      throw new Error("Intake delivery identity and content cannot change");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(job, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = directoryWrites.get(this.directory) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => {}, () => {});
    directoryWrites.set(this.directory, tail);
    try { return await result; } finally {
      if (directoryWrites.get(this.directory) === tail) directoryWrites.delete(this.directory);
    }
  }

  /** Reads one intake job by its stable internal ID. */
  async get(id: string): Promise<IntakeJob | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as IntakeJob;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Lists all persisted intake jobs for recovery. */
  async list(): Promise<IntakeJob[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const jobs: IntakeJob[] = [];
    for (const name of names.filter(name => name.endsWith(".json"))) {
      const job = await this.get(name.slice(0, -5));
      if (job) jobs.push(job);
    }
    return jobs;
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid intake job id");
    return join(this.directory, `${id}.json`);
  }
}

function createJobId(deliveryId: string): string {
  return createHash("sha256").update(deliveryId).digest("hex");
}
