import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, type Model } from "@mariozechner/pi-ai";
import type { SessionEntry, SessionMeta } from "./types.js";
import { appendEntry, readEntries, resolveSessionPath, writeEntries } from "./storage.js";
import { compactMessages, compactMessagesAsync } from "./compaction.js";
import { estimateTokenUsage, shouldCompact as shouldCompactTokens } from "../context-window/index.js";
import { credentialManager } from "../credentials.js";
import { repairSessionFileIfNeeded, type RepairReport } from "./session-file-repair.js";
import { sanitizeToolCallInputs, sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

/** Get Kimi model for summarization (use a cheaper model than k2-thinking) */
function getSummaryModel(): Model<any> {
  return (getModel as (p: string, m: string) => Model<any>)("kimi", "moonshot-v1-128k");
}

/** Get Kimi API key */
function getSummaryApiKey(): string | undefined {
  const providers = ["kimi", "moonshot", "kimi-coding"];
  for (const provider of providers) {
    const apiKey = credentialManager.getLlmProviderConfig(provider)?.apiKey;
    if (apiKey) return apiKey;
  }
  return undefined;
}

export type SessionManagerOptions = {
  sessionId: string;
  baseDir?: string | undefined;

  // Compaction mode configuration
  /** Compaction mode: "count" uses message count, "tokens" uses token awareness, "summary" uses LLM summary */
  compactionMode?: "count" | "tokens" | "summary" | undefined;

  // Count mode parameters
  maxMessages?: number | undefined;
  keepLast?: number | undefined;

  // Token mode parameters
  /** Context window token count */
  contextWindowTokens?: number | undefined;
  /** System prompt (used to calculate available tokens) */
  systemPrompt?: string | undefined;
  /** Tokens reserved for responses */
  reserveTokens?: number | undefined;
  /** Compaction target utilization ratio (0-1) */
  targetRatio?: number | undefined;
  /** Minimum messages to keep */
  minKeepMessages?: number | undefined;

  // Summary mode parameters
  /** LLM Model (for generating summary) */
  model?: Model<any> | undefined;
  /** API Key */
  apiKey?: string | undefined;
  /** Custom summary instructions */
  customInstructions?: string | undefined;
};

export class SessionManager {
  private readonly sessionId: string;
  private readonly baseDir: string | undefined;
  private readonly compactionMode: "count" | "tokens" | "summary";
  // Count mode
  private readonly maxMessages: number;
  private readonly keepLast: number;
  // Token mode
  private readonly contextWindowTokens: number;
  private systemPrompt: string | undefined;
  private readonly reserveTokens: number;
  private readonly targetRatio: number;
  private readonly minKeepMessages: number;
  // Summary mode
  private model: Model<any> | undefined;
  private apiKey: string | undefined;
  private readonly customInstructions: string | undefined;
  private previousSummary: string | undefined;

  private queue: Promise<void> = Promise.resolve();
  private meta: SessionMeta | undefined;

  constructor(options: SessionManagerOptions) {
    this.sessionId = options.sessionId;
    this.baseDir = options.baseDir;

    // Compaction mode
    this.compactionMode = options.compactionMode ?? "count";

    // Count mode parameters
    this.maxMessages = options.maxMessages ?? 80;
    this.keepLast = options.keepLast ?? 60;

    // Token mode parameters
    this.contextWindowTokens = options.contextWindowTokens ?? 200_000;
    this.systemPrompt = options.systemPrompt;
    this.reserveTokens = options.reserveTokens ?? 1024;
    this.targetRatio = options.targetRatio ?? 0.5;
    this.minKeepMessages = options.minKeepMessages ?? 10;

    // Summary mode parameters
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.customInstructions = options.customInstructions;

    this.meta = this.loadMeta();
  }

  /**
   * Update system prompt (for token mode calculation)
   */
  setSystemPrompt(systemPrompt: string | undefined) {
    this.systemPrompt = systemPrompt;
  }

  /**
   * Get current context window token count
   */
  getContextWindowTokens(): number {
    return this.contextWindowTokens;
  }

  /**
   * Set LLM Model (for summary mode)
   */
  setModel(model: Model<any> | undefined) {
    this.model = model;
  }

  /**
   * Set API Key (for summary mode)
   */
  setApiKey(apiKey: string | undefined) {
    this.apiKey = apiKey;
  }

  /**
   * Get current compaction mode
   */
  getCompactionMode(): "count" | "tokens" | "summary" {
    return this.compactionMode;
  }

  loadEntries(): SessionEntry[] {
    return readEntries(this.sessionId, { baseDir: this.baseDir });
  }

  async repairIfNeeded(warn?: (message: string) => void): Promise<RepairReport> {
    const filePath = resolveSessionPath(this.sessionId, { baseDir: this.baseDir });
    return repairSessionFileIfNeeded({ sessionFile: filePath, warn });
  }

  loadMessages(): AgentMessage[] {
    const entries = this.loadEntries();
    let messages = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    messages = sanitizeToolCallInputs(messages);
    messages = sanitizeToolUseResultPairing(messages);
    return messages;
  }

  loadMeta(): SessionMeta | undefined {
    const entries = this.loadEntries();
    let meta: SessionMeta | undefined;
    for (const entry of entries) {
      if (entry.type === "meta") {
        meta = entry.meta;
      }
    }
    return meta;
  }

  getMeta(): SessionMeta | undefined {
    return this.meta;
  }

  saveMeta(meta: SessionMeta) {
    this.meta = meta;
    void this.enqueue(() =>
      appendEntry(
        this.sessionId,
        { type: "meta", meta, timestamp: Date.now() },
        { baseDir: this.baseDir },
      ),
    );
  }

  saveMessage(message: AgentMessage) {
    void this.enqueue(() =>
      appendEntry(
        this.sessionId,
        { type: "message", message, timestamp: Date.now() },
        { baseDir: this.baseDir },
      ),
    );
  }

  /** Check whether compaction would trigger for the given messages (without executing it) */
  needsCompaction(messages: AgentMessage[]): boolean {
    if (this.compactionMode === "count") {
      return messages.length > this.maxMessages;
    }
    // Token and summary modes use the same token-based threshold
    const estimation = estimateTokenUsage({
      messages,
      systemPrompt: this.systemPrompt,
      contextWindowTokens: this.contextWindowTokens,
      reserveTokens: this.reserveTokens,
    });
    return shouldCompactTokens(estimation);
  }

  async maybeCompact(messages: AgentMessage[]) {
    let result;

    if (this.compactionMode === "summary") {
      // Use provided model/apiKey or fall back to Kimi
      const model = this.model ?? getSummaryModel();
      const apiKey = this.apiKey ?? getSummaryApiKey();

      if (!apiKey) {
        // No API key available, downgrade to tokens mode
        result = compactMessages(messages, {
          mode: "tokens",
          contextWindowTokens: this.contextWindowTokens,
          systemPrompt: this.systemPrompt,
          reserveTokens: this.reserveTokens,
          targetRatio: this.targetRatio,
          minKeepMessages: this.minKeepMessages,
        });
      } else {
        result = await compactMessagesAsync(messages, {
          mode: "summary",
          model,
          apiKey,
          contextWindowTokens: this.contextWindowTokens,
          systemPrompt: this.systemPrompt,
          reserveTokens: this.reserveTokens,
          targetRatio: this.targetRatio,
          minKeepMessages: this.minKeepMessages,
          customInstructions: this.customInstructions,
          previousSummary: this.previousSummary,
        });

        // Save summary for next incremental update
        if (result?.summary) {
          this.previousSummary = result.summary;
        }
      }
    } else {
      result = compactMessages(messages, {
        mode: this.compactionMode,
        // Count mode parameters
        maxMessages: this.maxMessages,
        keepLast: this.keepLast,
        // Token mode parameters
        contextWindowTokens: this.contextWindowTokens,
        systemPrompt: this.systemPrompt,
        reserveTokens: this.reserveTokens,
        targetRatio: this.targetRatio,
        minKeepMessages: this.minKeepMessages,
      });
    }

    if (!result) return null;

    const entries: SessionEntry[] = [];
    if (this.meta) {
      entries.push({ type: "meta", meta: this.meta, timestamp: Date.now() });
    }
    for (const message of result.kept) {
      entries.push({ type: "message", message, timestamp: Date.now() });
    }
    entries.push({
      type: "compaction",
      removed: result.removedCount,
      kept: result.kept.length,
      timestamp: Date.now(),
      // Additional information in Token/Summary mode
      tokensRemoved: result.tokensRemoved,
      tokensKept: result.tokensKept,
      summary: result.summary,
      reason: result.reason,
    });

    await this.enqueue(() =>
      writeEntries(this.sessionId, entries, { baseDir: this.baseDir }),
    );
    return result;
  }

  /**
   * Wait for all pending storage writes to complete.
   */
  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(task, task).catch((err) => {
      // Log for debuggability, but preserve failure for awaiters.
      console.error("[SessionManager] storage write failed:", err);
      throw err;
    });
    return this.queue;
  }
}
