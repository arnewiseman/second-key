import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** Stores authenticated webhook deliveries before worker processing starts. */
export class IntakeStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  /** Accepts one delivery and returns the existing job for a duplicate. */
  async accept(envelope: WebhookEnvelope, receivedAt: Date = new Date()): Promise<AcceptedIntake> {
    const deliveryId = envelope.delivery_id?.trim();
    if (!deliveryId) throw new Error("Webhook delivery ID is required");
    const existing = await this.getByDeliveryId(deliveryId);
    if (existing) return { job: existing, duplicate: true };
    const job: IntakeJob = {
      id: createJobId(deliveryId),
      deliveryId,
      event: envelope.event,
      data: envelope.data,
      receivedAt: receivedAt.toISOString(),
      state: "queued",
      attempts: 0,
      lastError: null,
    };
    await this.save(job);
    return { job, duplicate: false };
  }

  /** Finds a delivery by its provider identity for deduplication. */
  async getByDeliveryId(deliveryId: string): Promise<IntakeJob | null> {
    const id = deliveryId.trim();
    if (!id) return null;
    const jobs = await this.list();
    return jobs.find(job => job.deliveryId === id) ?? null;
  }

  /** Saves a job with an atomic replacement and immutable delivery identity. */
  async save(job: IntakeJob): Promise<void> {
    const target = this.path(job.id);
    const previous = await this.get(job.id);
    if (previous && previous.deliveryId !== job.deliveryId) throw new Error("Intake delivery identity cannot change");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(job, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, target);
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
    return (await Promise.all(names.filter(name => name.endsWith(".json")).map(name => this.get(name.slice(0, -5)))))
      .filter((job): job is IntakeJob => job !== null);
  }

  /** Builds a constrained path for a validated internal job ID. */
  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid intake job id");
    return join(this.directory, `${id}.json`);
  }
}

/** Derives a stable filesystem-safe job ID from the provider delivery ID. */
function createJobId(deliveryId: string): string {
  return createHash("sha256").update(deliveryId).digest("hex");
}
