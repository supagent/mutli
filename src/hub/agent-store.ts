import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../shared/index.js";

export interface AgentRecord {
  id: string;
  createdAt: number;
}

const AGENTS_DIR = join(DATA_DIR, "agents");
const AGENTS_FILE = join(AGENTS_DIR, "agents.json");

function ensureDir(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

export function loadAgentRecords(): AgentRecord[] {
  if (!existsSync(AGENTS_FILE)) return [];
  try {
    const content = readFileSync(AGENTS_FILE, "utf-8");
    return JSON.parse(content) as AgentRecord[];
  } catch {
    return [];
  }
}

export function saveAgentRecords(records: AgentRecord[]): void {
  ensureDir();
  writeFileSync(AGENTS_FILE, JSON.stringify(records, null, 2), "utf-8");
}

export function addAgentRecord(record: AgentRecord): void {
  const records = loadAgentRecords();
  if (records.some((r) => r.id === record.id)) return;
  records.push(record);
  saveAgentRecords(records);
}

export function removeAgentRecord(id: string): void {
  const records = loadAgentRecords();
  const filtered = records.filter((r) => r.id !== id);
  if (filtered.length !== records.length) {
    saveAgentRecords(filtered);
  }
}
