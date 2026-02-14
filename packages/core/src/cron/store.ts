/**
 * Cron Job Storage
 *
 * Persists jobs to JSON file and run logs to JSONL files.
 * Based on OpenClaw's implementation (MIT License)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "fs";
import path from "path";
import { DATA_DIR } from "@multica/utils";
import type { CronJob, CronRunLogEntry } from "./types.js";

/** Default cron storage directory */
const DEFAULT_CRON_DIR = path.join(DATA_DIR, "cron");

/** Store data structure */
type StoreData = {
  version: number;
  jobs: CronJob[];
};

const STORE_VERSION = 1;

export class CronStore {
  private readonly jobsPath: string;
  private readonly runsDir: string;
  private jobs: Map<string, CronJob> = new Map();
  private loaded = false;

  constructor(baseDir: string = DEFAULT_CRON_DIR) {
    this.jobsPath = path.join(baseDir, "jobs.json");
    this.runsDir = path.join(baseDir, "runs");
  }

  /** Ensure directories exist */
  private ensureDirs() {
    const dir = path.dirname(this.jobsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true });
    }
  }

  /** Load jobs from disk */
  load(): CronJob[] {
    this.ensureDirs();

    if (!existsSync(this.jobsPath)) {
      this.jobs = new Map();
      this.loaded = true;
      return [];
    }

    try {
      const raw = readFileSync(this.jobsPath, "utf-8");
      const data: StoreData = JSON.parse(raw);

      // Validate version
      if (data.version !== STORE_VERSION) {
        console.warn(`[CronStore] Store version mismatch: ${data.version} vs ${STORE_VERSION}`);
      }

      this.jobs = new Map(data.jobs.map((j) => [j.id, j]));
      this.loaded = true;
      return Array.from(this.jobs.values());
    } catch (error) {
      console.error("[CronStore] Failed to load jobs:", error);
      this.jobs = new Map();
      this.loaded = true;
      return [];
    }
  }

  /** Save jobs to disk */
  save(): void {
    this.ensureDirs();

    const data: StoreData = {
      version: STORE_VERSION,
      jobs: Array.from(this.jobs.values()),
    };

    // Write to temp file first, then rename (atomic)
    const tmpPath = this.jobsPath + ".tmp";
    const bakPath = this.jobsPath + ".bak";

    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");

      // Backup existing file
      if (existsSync(this.jobsPath)) {
        writeFileSync(bakPath, readFileSync(this.jobsPath));
      }

      // Rename temp to actual (atomic on most filesystems)
      renameSync(tmpPath, this.jobsPath);
    } catch (error) {
      console.error("[CronStore] Failed to save jobs:", error);
      throw error;
    }
  }

  /** Ensure store is loaded */
  private ensureLoaded() {
    if (!this.loaded) {
      this.load();
    }
  }

  /** Get a job by ID */
  get(id: string): CronJob | undefined {
    this.ensureLoaded();
    return this.jobs.get(id);
  }

  /** Set (create or update) a job */
  set(job: CronJob): void {
    this.ensureLoaded();
    this.jobs.set(job.id, job);
    this.save();
  }

  /** Delete a job by ID */
  delete(id: string): boolean {
    this.ensureLoaded();
    const deleted = this.jobs.delete(id);
    if (deleted) {
      this.save();
    }
    return deleted;
  }

  /** List all jobs, optionally filtered */
  list(filter?: { enabled?: boolean }): CronJob[] {
    this.ensureLoaded();
    let jobs = Array.from(this.jobs.values());

    if (filter?.enabled !== undefined) {
      jobs = jobs.filter((j) => j.enabled === filter.enabled);
    }

    // Sort by next run time
    jobs.sort((a, b) => {
      const aNext = a.state.nextRunAtMs ?? Infinity;
      const bNext = b.state.nextRunAtMs ?? Infinity;
      return aNext - bNext;
    });

    return jobs;
  }

  /** Get job count */
  count(filter?: { enabled?: boolean }): number {
    return this.list(filter).length;
  }

  // === Run Log Methods ===

  /** Append a run log entry */
  appendRunLog(jobId: string, entry: CronRunLogEntry): void {
    this.ensureDirs();
    const logPath = path.join(this.runsDir, `${jobId}.jsonl`);
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(logPath, line, "utf-8");
  }

  /** Get run logs for a job */
  getRunLogs(jobId: string, limit = 50): CronRunLogEntry[] {
    const logPath = path.join(this.runsDir, `${jobId}.jsonl`);

    if (!existsSync(logPath)) {
      return [];
    }

    try {
      const content = readFileSync(logPath, "utf-8").trim();
      if (!content) return [];

      const lines = content.split("\n");
      const entries = lines
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line) as CronRunLogEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is CronRunLogEntry => e !== null);

      return entries;
    } catch (error) {
      console.error(`[CronStore] Failed to read run logs for ${jobId}:`, error);
      return [];
    }
  }

  /** Clear run logs for a job */
  clearRunLogs(jobId: string): void {
    const logPath = path.join(this.runsDir, `${jobId}.jsonl`);
    if (existsSync(logPath)) {
      writeFileSync(logPath, "", "utf-8");
    }
  }

  /** Get the store path (for status display) */
  getStorePath(): string {
    return this.jobsPath;
  }
}
