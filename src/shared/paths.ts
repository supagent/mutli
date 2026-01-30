import { join } from "node:path";
import { homedir } from "node:os";

/** Root data directory: ~/.super-multica */
export const DATA_DIR = join(homedir(), ".super-multica");
