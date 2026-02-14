import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

import { resolveDataDir } from "./paths.js";

describe("resolveDataDir", () => {
  const original = process.env.SMC_DATA_DIR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SMC_DATA_DIR;
    } else {
      process.env.SMC_DATA_DIR = original;
    }
  });

  it("defaults to ~/.super-multica when SMC_DATA_DIR is not set", () => {
    delete process.env.SMC_DATA_DIR;
    expect(resolveDataDir()).toBe(join(homedir(), ".super-multica"));
  });

  it("uses absolute path from SMC_DATA_DIR", () => {
    process.env.SMC_DATA_DIR = "/tmp/test-multica";
    expect(resolveDataDir()).toBe("/tmp/test-multica");
  });

  it("expands ~ in SMC_DATA_DIR", () => {
    process.env.SMC_DATA_DIR = "~/.super-multica-dev";
    expect(resolveDataDir()).toBe(join(homedir(), ".super-multica-dev"));
  });

  it("handles ~ alone", () => {
    process.env.SMC_DATA_DIR = "~";
    expect(resolveDataDir()).toBe(homedir());
  });
});
