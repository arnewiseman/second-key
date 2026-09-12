import { mkdir, readFile, readdir, rename, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DecisionRecord } from "../types.ts";

/** Single-process JSON store. Callers serialize updates to a given request. */
export class RecordStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  private path(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid record id");
    return join(this.directory, `${id}.json`);
  }

  async get(id: string): Promise<DecisionRecord | null> {
    try { return JSON.parse(await readFile(this.path(id), "utf8")) as DecisionRecord; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(record: DecisionRecord): Promise<void> {
    const target = this.path(record.id);
    const previous = await this.get(record.id);
    if (previous) {
      if (JSON.stringify(previous.events) !== JSON.stringify(record.events.slice(0, previous.events.length))) {
        throw new Error("Audit history cannot be rewritten");
      }
      if (JSON.stringify(previous.analysis) !== JSON.stringify(record.analysis) || previous.created_at !== record.created_at) {
        throw new Error("Original analysis and creation time are immutable");
      }
      if (JSON.stringify(previous) !== JSON.stringify(record) && record.events.length <= previous.events.length) {
        throw new Error("Record updates require an audit event");
      }
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record, null, 2) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, target);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async list(): Promise<DecisionRecord[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return (await Promise.all(names.filter(n => n.endsWith(".json")).map(n => this.get(n.slice(0, -5)))))
      .filter((record): record is DecisionRecord => record !== null);
  }
}
