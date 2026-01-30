/**
 * Agent Profile 文件存储
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_FILES, type AgentProfile } from "./types.js";
import { DATA_DIR } from "../../shared/index.js";

const DEFAULT_BASE_DIR = join(DATA_DIR, "agent-profiles");

export interface StorageOptions {
  baseDir?: string | undefined;
}

/** 获取 profile 目录路径 */
export function getProfileDir(profileId: string, options?: StorageOptions): string {
  const baseDir = options?.baseDir ?? DEFAULT_BASE_DIR;
  return join(baseDir, profileId);
}

/** 确保 profile 目录存在 */
export function ensureProfileDir(profileId: string, options?: StorageOptions): string {
  const dir = getProfileDir(profileId, options);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 检查 profile 是否存在 */
export function profileExists(profileId: string, options?: StorageOptions): boolean {
  const dir = getProfileDir(profileId, options);
  return existsSync(dir);
}

/** 读取单个 profile 文件 */
export function readProfileFile(
  profileId: string,
  fileName: string,
  options?: StorageOptions,
): string | undefined {
  const dir = getProfileDir(profileId, options);
  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) {
    return undefined;
  }
  return readFileSync(filePath, "utf-8");
}

/** 写入单个 profile 文件 */
export function writeProfileFile(
  profileId: string,
  fileName: string,
  content: string,
  options?: StorageOptions,
): void {
  const dir = ensureProfileDir(profileId, options);
  const filePath = join(dir, fileName);
  writeFileSync(filePath, content, "utf-8");
}

/** 加载完整的 AgentProfile */
export function loadProfile(profileId: string, options?: StorageOptions): AgentProfile {
  return {
    id: profileId,
    soul: readProfileFile(profileId, PROFILE_FILES.soul, options),
    identity: readProfileFile(profileId, PROFILE_FILES.identity, options),
    tools: readProfileFile(profileId, PROFILE_FILES.tools, options),
    memory: readProfileFile(profileId, PROFILE_FILES.memory, options),
    bootstrap: readProfileFile(profileId, PROFILE_FILES.bootstrap, options),
  };
}

/** 保存 AgentProfile（只写入非空字段） */
export function saveProfile(profile: AgentProfile, options?: StorageOptions): void {
  const { id, soul, identity, tools, memory, bootstrap } = profile;

  if (soul !== undefined) {
    writeProfileFile(id, PROFILE_FILES.soul, soul, options);
  }
  if (identity !== undefined) {
    writeProfileFile(id, PROFILE_FILES.identity, identity, options);
  }
  if (tools !== undefined) {
    writeProfileFile(id, PROFILE_FILES.tools, tools, options);
  }
  if (memory !== undefined) {
    writeProfileFile(id, PROFILE_FILES.memory, memory, options);
  }
  if (bootstrap !== undefined) {
    writeProfileFile(id, PROFILE_FILES.bootstrap, bootstrap, options);
  }
}
