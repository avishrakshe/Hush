import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type HushStoreData, MemoryHushStore, emptyStoreData } from "../client/store.js";

/**
 * Node-only: an agent's private payment history persisted as a JSON file (atomic write-then-rename).
 * This file IS the agent's private ledger — keep it out of git and backups you don't control.
 */
export class JsonFileHushStore extends MemoryHushStore {
  constructor(private readonly file: string) {
    super(existsSync(file) ? { ...emptyStoreData(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<HushStoreData>) } : emptyStoreData());
    mkdirSync(path.dirname(file), { recursive: true });
  }

  protected override async persist(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
