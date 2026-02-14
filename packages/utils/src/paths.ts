import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the root data directory.
 * Override with SMC_DATA_DIR env var (supports ~ expansion).
 * Defaults to ~/.super-multica.
 */
export function resolveDataDir(): string {
  const envDir = process.env.SMC_DATA_DIR;
  if (envDir) {
    return envDir.startsWith("~")
      ? join(homedir(), envDir.slice(1))
      : envDir;
  }
  return join(homedir(), ".super-multica");
}

/** Root data directory (default: ~/.super-multica, override: SMC_DATA_DIR) */
export const DATA_DIR = resolveDataDir();

/** Cache directory for downloaded media files */
export const MEDIA_CACHE_DIR = join(DATA_DIR, "cache", "media");

/** Default workspace base directory: ~/Documents/Multica */
export const DEFAULT_WORKSPACE_DIR = join(homedir(), "Documents", "Multica");
