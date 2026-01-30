import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { DATA_DIR } from "../shared/index.js";

const DEVICE_ID_FILE = join(DATA_DIR, "device-id");

/**
 * 获取当前设备的 ID。
 * 首次调用时生成 UUIDv7 并持久化到 ~/.multica/device-id，
 * 后续调用直接读取。
 */
export function getDeviceId(): string {
  try {
    return readFileSync(DEVICE_ID_FILE, "utf-8").trim();
  } catch {
    const id = uuidv7();
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DEVICE_ID_FILE, id, "utf-8");
    return id;
  }
}
