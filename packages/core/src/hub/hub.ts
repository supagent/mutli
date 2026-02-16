import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { v7 as uuidv7 } from "uuid";
import {
  GatewayClient,
  type ConnectionState,
  type RoutedMessage,
  type SendErrorResponse,
  RequestAction,
  ResponseAction,
  StreamAction,
  type RequestPayload,
  type ResponseSuccessPayload,
  type ResponseErrorPayload,
} from "../client/index.js";
import { AsyncAgent } from "../agent/async-agent.js";
import type { AgentOptions } from "../agent/types.js";
import { getHubId } from "./hub-identity.js";
import { setHub } from "./hub-singleton.js";
import {
  loadHubStoreSnapshot,
  upsertAgentRecord,
  upsertConversationRecord,
  removeConversationRecordById,
  removeAgentRecordById,
} from "./agent-store.js";
import { RpcDispatcher, RpcError } from "./rpc/dispatcher.js";
import { createGetAgentMessagesHandler } from "./rpc/handlers/get-agent-messages.js";
import { createGetHubInfoHandler } from "./rpc/handlers/get-hub-info.js";
import { createListAgentsHandler } from "./rpc/handlers/list-agents.js";
import { createCreateAgentHandler } from "./rpc/handlers/create-agent.js";
import { createDeleteAgentHandler } from "./rpc/handlers/delete-agent.js";
import { createListConversationsHandler } from "./rpc/handlers/list-conversations.js";
import { createCreateConversationHandler } from "./rpc/handlers/create-conversation.js";
import { createDeleteConversationHandler } from "./rpc/handlers/delete-conversation.js";
import { createUpdateGatewayHandler } from "./rpc/handlers/update-gateway.js";
import { createGetLastHeartbeatHandler } from "./rpc/handlers/get-last-heartbeat.js";
import { createSetHeartbeatsHandler } from "./rpc/handlers/set-heartbeats.js";
import { createWakeHeartbeatHandler } from "./rpc/handlers/wake-heartbeat.js";
import { DeviceStore, type DeviceMeta } from "./device-store.js";
import { createVerifyHandler } from "./rpc/handlers/verify.js";
import { createGenerateChannelWelcomeHandler } from "./rpc/handlers/generate-channel-welcome.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createResolveExecApprovalHandler } from "./rpc/handlers/resolve-exec-approval.js";
import { evaluateCommandSafety, requiresApproval } from "../agent/tools/exec-safety.js";
import { addAllowlistEntry, recordAllowlistUse, matchAllowlist } from "../agent/tools/exec-allowlist.js";
import type { ExecApprovalCallback, ExecApprovalConfig, ApprovalResult, ExecApprovalRequest } from "../agent/tools/exec-approval-types.js";
import { readProfileConfig, writeProfileConfig } from "../agent/profile/storage.js";
import { ChannelManager, initChannels } from "../channels/index.js";
import { getCronService, shutdownCronService, executeCronJob } from "../cron/index.js";
import {
  getLastHeartbeatEvent,
  onHeartbeatEvent,
  requestHeartbeatNow,
  runHeartbeatOnce,
  setHeartbeatsEnabled,
  startHeartbeatRunner,
  type HeartbeatEventPayload,
  type HeartbeatRunResult,
  type HeartbeatRunner,
} from "../heartbeat/index.js";
import { enqueueSystemEvent } from "../heartbeat/system-events.js";
import { isHeartbeatAckEvent } from "./heartbeat-filter.js";

// ============ Message Source Types ============

/** Message source: where did this inbound message come from? */
export type MessageSource =
  | { type: "local" }
  | { type: "gateway"; deviceId: string }
  | { type: "channel"; channelId: string; accountId: string; conversationId: string };

/** Inbound message event broadcast to all listeners */
export interface InboundMessageEvent {
  agentId: string;
  /** Conversation ID for this inbound message. */
  conversationId: string;
  content: string;
  source: MessageSource;
  timestamp: number;
}

export class Hub {
  private readonly allowLegacyAgentConversationFallback = process.env.MULTICA_ALLOW_LEGACY_AGENT_FALLBACK === "1";
  private readonly warnedConversationFallbackAgents = new Set<string>();
  // Runtime conversation map (conversationId -> AsyncAgent).
  private readonly agents = new Map<string, AsyncAgent>();
  // Conversation ownership map (conversationId -> logical agentId).
  private readonly conversationAgents = new Map<string, string>();
  // Main conversation pointer for each agent (agentId -> mainConversationId).
  private readonly agentMainConversations = new Map<string, string>();
  // Runtime profile for each logical agent.
  private readonly agentProfiles = new Map<string, string>();
  private readonly agentSenders = new Map<string, string>();
  private readonly agentStreamIds = new Map<string, string>();
  private readonly agentStreamCounters = new Map<string, number>();
  private readonly pendingAssistantStarts = new Map<string, { agentId: string; conversationId: string; event: unknown }>();
  private readonly suppressedStreamAgents = new Set<string>();
  private readonly localApprovalHandlers = new Map<string, (payload: ExecApprovalRequest) => void>();
  private readonly inboundListeners = new Set<(event: InboundMessageEvent) => void>();
  private readonly rpc: RpcDispatcher;
  private readonly approvalManager: ExecApprovalManager;
  private readonly heartbeatListeners = new Set<(event: HeartbeatEventPayload) => void>();
  private heartbeatRunner: HeartbeatRunner | null = null;
  private heartbeatUnsubscribe: (() => void) | null = null;
  private client: GatewayClient;
  readonly deviceStore: DeviceStore;
  private _onConfirmDevice: (
    (deviceId: string, agentId: string, conversationId: string, meta?: DeviceMeta) => Promise<boolean>
  ) | null = null;
  private _stateChangeListeners: ((state: ConnectionState) => void)[] = [];
  readonly channelManager: ChannelManager;
  url: string;
  readonly path: string;
  readonly hubId: string;

  /** Current Gateway connection state */
  get connectionState(): ConnectionState {
    return this.client.state;
  }

  constructor(url: string, path?: string) {
    this.url = url;
    this.path = path ?? "/ws";
    this.hubId = getHubId();
    this.deviceStore = new DeviceStore();

    this.rpc = new RpcDispatcher();
    this.rpc.register("verify", createVerifyHandler({
      hubId: this.hubId,
      deviceStore: this.deviceStore,
      resolveMainConversationId: (agentId) => this.getAgentMainConversationId(agentId),
      onConfirmDevice: (deviceId, agentId, conversationId, meta) => {
        if (!this._onConfirmDevice) {
          // No UI confirm handler registered (CLI mode etc.) — auto-approve
          return Promise.resolve(true);
        }
        return this._onConfirmDevice(deviceId, agentId, conversationId, meta);
      },
    }));
    this.rpc.register("generateChannelWelcome", createGenerateChannelWelcomeHandler(this));
    this.rpc.register("getAgentMessages", createGetAgentMessagesHandler((agentId, conversationId) => {
      const resolvedConversationId = this.resolveConversationId(agentId, conversationId);
      if (!resolvedConversationId) return null;
      return {
        conversationId: resolvedConversationId,
        storageAgentId: this.getConversationAgentId(resolvedConversationId) ?? this.normalizeId(agentId),
      };
    }));
    this.rpc.register("getHubInfo", createGetHubInfoHandler(this));
    this.rpc.register("listAgents", createListAgentsHandler(this));
    this.rpc.register("createAgent", createCreateAgentHandler(this));
    this.rpc.register("deleteAgent", createDeleteAgentHandler(this));
    this.rpc.register("listConversations", createListConversationsHandler(this));
    this.rpc.register("createConversation", createCreateConversationHandler(this));
    this.rpc.register("deleteConversation", createDeleteConversationHandler(this));
    this.rpc.register("updateGateway", createUpdateGatewayHandler(this));
    this.rpc.register("last-heartbeat", createGetLastHeartbeatHandler(this));
    this.rpc.register("set-heartbeats", createSetHeartbeatsHandler(this));
    this.rpc.register("wake-heartbeat", createWakeHeartbeatHandler(this));

    // Initialize exec approval manager
    this.approvalManager = new ExecApprovalManager((conversationId, payload) => {
      // Check local IPC handler first (for desktop direct chat)
      const localHandler = this.localApprovalHandlers.get(conversationId);
      if (localHandler) {
        localHandler(payload);
        return;
      }
      // Remote: send via Gateway
      const targetDeviceId = this.agentSenders.get(conversationId);
      if (!targetDeviceId) {
        throw new Error(`No client device found for conversation ${conversationId}`);
      }
      this.client.send(targetDeviceId, "exec-approval-request", payload);
    });
    this.rpc.register("resolveExecApproval", createResolveExecApprovalHandler(this.approvalManager));

    // Register as global singleton for cross-module access.
    setHub(this);

    // Initialize and start cron service
    this.initCronService();
    this.initHeartbeatService();

    // Initialize channel plugin system (before restoreAgents so channelManager is available)
    console.log("[Hub] Initializing channel system...");
    initChannels();
    this.channelManager = new ChannelManager(this);

    this.client = this.createClient(this.url);
    this.client.connect();
    this.restoreAgents();

    // Start channel accounts (async — bot connections happen in background)
    void this.channelManager.startAll().then(() => {
      console.log("[Hub] Channel system started");
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Hub] Channel system failed to start: ${msg}`);
    });
  }

  /** Initialize cron service with executor */
  private initCronService(): void {
    const cronService = getCronService();
    cronService.setExecutor(executeCronJob);
    cronService.start().catch((err) => {
      console.error("[Hub] Failed to start cron service:", err);
    });
    console.log("[Hub] Cron service initialized");
  }

  /** Initialize heartbeat runner + event fanout. */
  private initHeartbeatService(): void {
    this.heartbeatRunner = startHeartbeatRunner({
      getAgent: () => this.getDefaultAgent(),
      logger: console,
    });

    this.heartbeatUnsubscribe = onHeartbeatEvent((event) => {
      for (const listener of this.heartbeatListeners) {
        try {
          listener(event);
        } catch {
          // Keep fanout resilient against listener errors.
        }
      }
    });

    console.log("[Hub] Heartbeat service initialized");
  }

  private getDefaultAgent(): AsyncAgent | null {
    const firstConversationId = this.listConversations()[0];
    if (!firstConversationId) return null;
    return this.getConversation(firstConversationId) ?? null;
  }

  /** Restore agents from persistent storage */
  private restoreAgents(): void {
    const snapshot = loadHubStoreSnapshot();

    for (const agent of snapshot.agents) {
      this.agentProfiles.set(agent.id, agent.profileId ?? "default");
    }

    for (const conversation of snapshot.conversations) {
      this.createConversation(conversation.id, {
        agentId: conversation.agentId,
        profileId: conversation.profileId ?? this.agentProfiles.get(conversation.agentId) ?? "default",
        persist: false,
        createdAt: conversation.createdAt,
        isMainConversation: !this.agentMainConversations.has(conversation.agentId),
      });
    }

    if (snapshot.conversations.length > 0) {
      console.log(
        `[Hub] Restored ${snapshot.agents.length} agent(s), ${snapshot.conversations.length} conversation(s)`,
      );
    }
  }

  private normalizeId(value: string | undefined): string | undefined {
    const normalized = (value ?? "").trim();
    return normalized || undefined;
  }

  private listConversationIdsForAgent(agentId: string): string[] {
    const ids: string[] = [];
    for (const [conversationId, ownerAgentId] of this.conversationAgents.entries()) {
      const runtime = this.agents.get(conversationId);
      if (ownerAgentId === agentId && runtime && !runtime.closed) {
        ids.push(conversationId);
      }
    }
    return ids;
  }

  private resolveAgentMainConversationId(agentId: string): string | undefined {
    const main = this.agentMainConversations.get(agentId);
    if (main) {
      const runtime = this.agents.get(main);
      if (runtime && !runtime.closed) {
        return main;
      }
    }

    const fallback = this.listConversationIdsForAgent(agentId)[0];
    if (!fallback) return undefined;
    this.agentMainConversations.set(agentId, fallback);
    return fallback;
  }

  private resolveAgentId(agentId: string | undefined, conversationId: string): string {
    const explicitAgentId = this.normalizeId(agentId);
    if (explicitAgentId && this.agentMainConversations.has(explicitAgentId)) {
      return explicitAgentId;
    }
    if (explicitAgentId && this.conversationAgents.has(explicitAgentId)) {
      return this.conversationAgents.get(explicitAgentId) ?? explicitAgentId;
    }
    const owner = this.conversationAgents.get(conversationId);
    if (owner) return owner;
    return explicitAgentId ?? conversationId;
  }

  private resolveTargetAgentId(agentId: string | undefined, fallbackConversationId: string): string {
    const normalized = this.normalizeId(agentId);
    if (normalized) return normalized;
    const firstAgentId = this.listAgents()[0];
    return firstAgentId ?? fallbackConversationId;
  }

  private registerAgent(
    agentId: string,
    options: { profileId: string; createdAt: number; persist: boolean },
  ): void {
    const exists = this.agentProfiles.has(agentId);
    if (exists) {
      const currentProfileId = this.agentProfiles.get(agentId);
      if (currentProfileId !== options.profileId) {
        this.agentProfiles.set(agentId, options.profileId);
      }
      return;
    }

    this.agentProfiles.set(agentId, options.profileId);
    if (options.persist) {
      upsertAgentRecord({
        id: agentId,
        createdAt: options.createdAt,
        profileId: options.profileId,
      });
    }
  }

  private clearAgentIfNoConversation(agentId: string): void {
    const remaining = this.listConversationIdsForAgent(agentId);
    if (remaining.length > 0) {
      if (!this.agentMainConversations.get(agentId)) {
        this.agentMainConversations.set(agentId, remaining[0]!);
      }
      return;
    }
    this.agentMainConversations.delete(agentId);
    this.agentProfiles.delete(agentId);
    removeAgentRecordById(agentId);
  }

  private closeConversationRuntime(conversationId: string, options?: { persist?: boolean }): { ok: boolean; agentId?: string } {
    const runtime = this.agents.get(conversationId);
    if (!runtime) return { ok: false };

    const agentId = this.conversationAgents.get(conversationId) ?? conversationId;
    runtime.close();
    this.approvalManager.cancelPending(conversationId);
    this.agents.delete(conversationId);
    this.conversationAgents.delete(conversationId);
    this.agentSenders.delete(conversationId);
    this.agentStreamIds.delete(conversationId);
    this.agentStreamCounters.delete(conversationId);
    this.clearPendingAssistantStarts(conversationId);
    this.suppressedStreamAgents.delete(conversationId);
    this.localApprovalHandlers.delete(conversationId);

    if (options?.persist !== false) {
      removeConversationRecordById(conversationId);
    }

    return { ok: true, agentId };
  }

  private createClient(url: string): GatewayClient {
    const client = new GatewayClient({
      url,
      path: this.path,
      deviceId: this.hubId,
      deviceType: "hub",
      autoReconnect: true,
      reconnectDelay: 1000,
    });

    client.onStateChange((state: ConnectionState) => {
      console.log(`[Hub] Connection state: ${state}`);
      for (const listener of this._stateChangeListeners) {
        listener(state);
      }
    });

    client.onRegistered((deviceId: string) => {
      console.log(`[Hub] Registered as: ${deviceId}`);
    });

    client.onError((err: Error) => {
      console.error(`[Hub] Connection error:`, err.message);
    });

    client.onMessage((msg: RoutedMessage) => {
      console.log(`[Hub] Received message: id=${msg.id} from=${msg.from} to=${msg.to} action=${msg.action} payload=${JSON.stringify(msg.payload)}`);

      // RPC request
      if (msg.action === RequestAction) {
        const payload = msg.payload as RequestPayload;
        // verify RPC is always allowed (it IS the verification step)
        if (payload.method === "verify") {
          void this.handleRpc(msg.from, payload);
          return;
        }
        // Other RPCs require verified device
        if (!this.deviceStore.isAllowed(msg.from)) {
          this.client.send<ResponseErrorPayload>(msg.from, ResponseAction, {
            requestId: payload.requestId,
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Device not verified" },
          });
          return;
        }
        void this.handleRpc(msg.from, payload);
        return;
      }

      // Non-RPC messages also require verified device
      const payload = msg.payload as {
        agentId?: string;
        conversationId?: string;
        sessionId?: string;
        content?: string;
      } | undefined;
      if (!this.deviceStore.isAllowed(msg.from)) {
        console.warn(`[Hub] Rejected message from unverified device: ${msg.from}`);
        const inboundSessionId = payload?.sessionId ?? payload?.conversationId;
        this.client.send(msg.from, "error", {
          code: "UNAUTHORIZED",
          message: "Device not verified. Please complete verification first.",
          messageId: msg.id,
          ...(inboundSessionId ? { conversationId: inboundSessionId, sessionId: inboundSessionId } : {}),
        });
        return;
      }
      const incomingAgentId = payload?.agentId;
      const conversationId = this.resolveConversationId(
        incomingAgentId,
        payload?.sessionId ?? payload?.conversationId,
      );
      const agentId = this.resolveAgentId(incomingAgentId, conversationId);
      const content = payload?.content;
      if (!content) {
        console.warn("[Hub] Invalid payload, missing content");
        return;
      }
      if (!conversationId) {
        const inboundSessionId = payload?.sessionId ?? payload?.conversationId;
        this.client.send(msg.from, "error", {
          code: "INVALID_PARAMS",
          message: "Unable to resolve sessionId (conversationId). Please provide a valid sessionId.",
          messageId: msg.id,
          ...(inboundSessionId ? { conversationId: inboundSessionId, sessionId: inboundSessionId } : {}),
        });
        return;
      }

      const allowedScope = this.deviceStore.isAllowed(msg.from, conversationId);
      if (!allowedScope) {
        console.warn(`[Hub] Rejected message outside authorized conversation scope: ${msg.from} -> ${conversationId}`);
        this.client.send(msg.from, "error", {
          code: "UNAUTHORIZED",
          message: "Device is not authorized for this conversation.",
          messageId: msg.id,
          conversationId,
          sessionId: conversationId,
        });
        return;
      }

      if (allowedScope.agentId !== agentId) {
        console.warn(
          `[Hub] Rejected message due to agent mismatch: device=${msg.from}, allowedAgent=${allowedScope.agentId}, targetAgent=${agentId}`,
        );
        this.client.send(msg.from, "error", {
          code: "UNAUTHORIZED",
          message: "Device is not authorized for this agent.",
          messageId: msg.id,
          conversationId,
          sessionId: conversationId,
        });
        return;
      }

      const agent = this.agents.get(conversationId);
      if (agent && !agent.closed) {
        this.agentSenders.set(conversationId, msg.from);
        this.channelManager.clearLastRoute();
        const source: MessageSource = { type: "gateway", deviceId: msg.from };
        this.broadcastInbound({
          agentId,
          conversationId,
          content,
          source,
          timestamp: Date.now(),
        });
        agent.write(content, { source });
      } else {
        console.warn(`[Hub] Conversation not found or closed: ${conversationId} (agent=${incomingAgentId})`);
      }
    });

    client.onSendError((err: SendErrorResponse) => {
      console.error(`[Hub] Send error: messageId=${err.messageId} code=${err.code} error=${err.error}`);
    });

    return client;
  }

  /** Register a confirmation handler for new device connections (called by Desktop UI) */
  setConfirmHandler(
    handler: (
      (deviceId: string, agentId: string, conversationId: string, meta?: DeviceMeta) => Promise<boolean>
    ) | null,
  ): void {
    this._onConfirmDevice = handler;
  }

  /** Subscribe to connection state changes. Returns unsubscribe function. */
  onConnectionStateChange(callback: (state: ConnectionState) => void): () => void {
    this._stateChangeListeners.push(callback);
    return () => {
      const idx = this._stateChangeListeners.indexOf(callback);
      if (idx >= 0) this._stateChangeListeners.splice(idx, 1);
    };
  }

  /** Subscribe to inbound messages from all sources. Returns unsubscribe function. */
  onInboundMessage(callback: (event: InboundMessageEvent) => void): () => void {
    this.inboundListeners.add(callback);
    return () => {
      this.inboundListeners.delete(callback);
    };
  }

  /** Broadcast an inbound message to all listeners */
  broadcastInbound(event: InboundMessageEvent): void {
    for (const listener of this.inboundListeners) {
      listener(event);
    }
  }

  /** Register a one-time token for device verification (called when QR code is generated) */
  registerToken(token: string, agentId: string, conversationId: string, expiresAt: number): void {
    const normalizedAgentId = this.normalizeId(agentId);
    const normalizedConversationId = this.normalizeId(conversationId);
    if (!normalizedAgentId || !normalizedConversationId) return;

    const resolvedConversationId = this.resolveConversationId(normalizedAgentId, normalizedConversationId);
    const ownerAgentId = this.conversationAgents.get(resolvedConversationId);
    if (ownerAgentId && ownerAgentId !== normalizedAgentId) {
      console.warn(
        `[Hub] registerToken rejected due to agent/conversation mismatch: agent=${normalizedAgentId}, conversation=${resolvedConversationId}, owner=${ownerAgentId}`,
      );
      return;
    }
    const resolvedAgentId = ownerAgentId ?? normalizedAgentId;
    this.deviceStore.registerToken(token, resolvedAgentId, resolvedConversationId, expiresAt);
  }

  /** 重连到新的 Gateway 地址 */
  reconnect(url: string): void {
    console.log(`[Hub] Reconnecting to ${url}`);
    this.client.disconnect();
    this.url = url;
    this.client = this.createClient(url);
    this.client.connect();
  }

  /** Register a local IPC handler for exec approval requests (desktop direct chat). */
  setLocalApprovalHandler(agentId: string, handler: (payload: ExecApprovalRequest) => void): void {
    this.localApprovalHandlers.set(agentId, handler);
  }

  /** Remove local approval handler for an agent. */
  removeLocalApprovalHandler(agentId: string): void {
    this.localApprovalHandlers.delete(agentId);
  }

  /** Resolve a pending exec approval (used by local IPC). */
  resolveExecApproval(approvalId: string, decision: "allow-once" | "allow-always" | "deny"): boolean {
    return this.approvalManager.resolveApproval(approvalId, decision);
  }

  /** Create a logical agent and its main conversation runtime. */
  createAgent(
    id?: string,
    options?: { persist?: boolean; profileId?: string; mainConversationId?: string; createdAt?: number },
  ): AsyncAgent {
    const agentId = this.normalizeId(id) ?? uuidv7();
    const existingMainConversationId = this.resolveAgentMainConversationId(agentId);
    if (existingMainConversationId) {
      const existing = this.agents.get(existingMainConversationId);
      if (existing && !existing.closed) {
        return existing;
      }
    }

    const mainConversationId = this.normalizeId(options?.mainConversationId) ?? agentId;
    return this.createConversation(mainConversationId, {
      agentId,
      profileId: options?.profileId,
      persist: options?.persist,
      isMainConversation: true,
      createdAt: options?.createdAt,
    });
  }

  /**
   * Create a new conversation runtime.
   *
   * Semantics:
   * - Agent = long-lived capability/profile identity
   * - Conversation = isolated runtime/session thread
   */
  createConversation(
    id?: string,
    options?: {
      persist?: boolean;
      profileId?: string;
      agentId?: string;
      isMainConversation?: boolean;
      createdAt?: number;
    },
  ): AsyncAgent {
    const conversationId = this.normalizeId(id) ?? uuidv7();
    const existing = this.agents.get(conversationId);
    if (existing && !existing.closed) {
      return existing;
    }

    const targetAgentId = this.resolveTargetAgentId(options?.agentId, conversationId);
    const profileId = options?.profileId ?? this.agentProfiles.get(targetAgentId) ?? "default";
    const createdAt = options?.createdAt ?? Date.now();
    const persist = options?.persist !== false;

    this.registerAgent(targetAgentId, {
      profileId,
      createdAt,
      persist,
    });

    const onExecApprovalNeeded = this.createExecApprovalCallback(conversationId, targetAgentId, profileId);
    const onChannelSendFile = this.createChannelSendFileCallback(conversationId);
    const channels = this.channelManager.listChannelInfos();
    const agent = new AsyncAgent({
      sessionId: conversationId,
      ownerAgentId: targetAgentId,
      profileId,
      onExecApprovalNeeded,
      onChannelSendFile,
      channels,
    });

    this.agents.set(conversationId, agent);
    this.conversationAgents.set(conversationId, targetAgentId);
    if (options?.isMainConversation || !this.agentMainConversations.has(targetAgentId)) {
      this.agentMainConversations.set(targetAgentId, conversationId);
    }

    if (persist) {
      upsertConversationRecord({
        id: conversationId,
        agentId: targetAgentId,
        createdAt,
        profileId,
      });
    }

    // Internally consume agent output (AgentEvent stream + error Messages)
    void this.consumeAgent(agent);
    this.heartbeatRunner?.updateConfig();

    console.log(`[Hub] Conversation created: ${conversationId} (agent: ${targetAgentId})`);
    return agent;
  }

  private getMessageIdFromEvent(event: unknown): string | undefined {
    if (!event || typeof event !== "object") return undefined;
    const maybeMsg = (event as { message?: unknown }).message;
    if (!maybeMsg || typeof maybeMsg !== "object") return undefined;
    const id = (maybeMsg as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }

  private resolveConversationId(agentId: string | undefined, conversationId?: string): string {
    const normalizedConversationId = this.normalizeId(conversationId);
    if (normalizedConversationId) return normalizedConversationId;

    const normalizedAgentId = this.normalizeId(agentId);
    if (!normalizedAgentId) return "";

    const mainConversationId = this.resolveAgentMainConversationId(normalizedAgentId);
    if (mainConversationId) return mainConversationId;

    if (this.allowLegacyAgentConversationFallback) {
      if (!this.warnedConversationFallbackAgents.has(normalizedAgentId)) {
        this.warnedConversationFallbackAgents.add(normalizedAgentId);
        console.warn(
          `[Hub] Legacy fallback enabled: using agentId as conversationId for ${normalizedAgentId}. ` +
          "Set explicit conversationId in clients to avoid this deprecated path.",
        );
      }
      return normalizedAgentId;
    }

    if (!this.warnedConversationFallbackAgents.has(normalizedAgentId)) {
      this.warnedConversationFallbackAgents.add(normalizedAgentId);
      console.warn(
        `[Hub] Conversation resolution failed for agent ${normalizedAgentId}: no main conversation found and legacy fallback is disabled.`,
      );
    }
    return "";
  }

  private beginStream(agentId: string, event: unknown): string {
    const explicitId = this.getMessageIdFromEvent(event);
    if (explicitId) {
      this.agentStreamIds.set(agentId, explicitId);
      return explicitId;
    }
    const next = (this.agentStreamCounters.get(agentId) ?? 0) + 1;
    this.agentStreamCounters.set(agentId, next);
    const fallback = `${agentId}:${next}`;
    this.agentStreamIds.set(agentId, fallback);
    return fallback;
  }

  private getActiveStreamId(agentId: string, event: unknown): string {
    return this.agentStreamIds.get(agentId) ?? this.getMessageIdFromEvent(event) ?? agentId;
  }

  private endStream(agentId: string): void {
    this.agentStreamIds.delete(agentId);
  }

  private clearPendingAssistantStarts(agentId: string): void {
    for (const [streamId, pending] of this.pendingAssistantStarts) {
      if (pending.agentId === agentId || pending.conversationId === agentId) {
        this.pendingAssistantStarts.delete(streamId);
      }
    }
  }

  /** Internally read agent output and send via Gateway */
  private async consumeAgent(agent: AsyncAgent): Promise<void> {
    const conversationId = agent.sessionId;
    const agentId = this.conversationAgents.get(conversationId) ?? conversationId;
    for await (const item of agent.read()) {
      const targetDeviceId = this.agentSenders.get(conversationId);
      if (!targetDeviceId) continue;

      if ("content" in item) {
        // Legacy Message (error fallback)
        console.log(`[${conversationId}] ${item.content}`);
        this.client.send(targetDeviceId, "message", {
          agentId,
          conversationId,
          sessionId: conversationId,
          content: item.content,
        });
      } else {
        const suppressForAgent = this.suppressedStreamAgents.has(conversationId);

        // Suppress all user-visible stream events during silent heartbeat runs.
        if (suppressForAgent) {
          if (item.type === "message_start") {
            this.beginStream(conversationId, item);
          } else if (item.type === "message_end") {
            const streamId = this.getActiveStreamId(conversationId, item);
            this.pendingAssistantStarts.delete(streamId);
            this.endStream(conversationId);
          }
          continue;
        }

        // Passthrough events: forward with synthetic streamId (no stream tracking)
        const isPassthroughEvent =
          item.type === "compaction_start" || item.type === "compaction_end" || item.type === "agent_error";
        if (isPassthroughEvent) {
          this.client.send(targetDeviceId, StreamAction, {
            streamId: `system:${conversationId}`,
            agentId,
            conversationId,
            sessionId: conversationId,
            event: item,
          });
          continue;
        }

        // Filter: only forward events useful for frontend rendering
        const maybeMessage = (item as { message?: { role?: string } }).message;
        const isAssistantMessage = maybeMessage?.role === "assistant";
        const shouldForward =
          ((item.type === "message_start" || item.type === "message_update" || item.type === "message_end") && isAssistantMessage)
          || item.type === "tool_execution_start"
          || item.type === "tool_execution_update"
          || item.type === "tool_execution_end";
        if (!shouldForward) continue;

        const isAssistantMessageEvent =
          item.type === "message_start" || item.type === "message_update" || item.type === "message_end";

        // Delay assistant message_start forwarding until we see content.
        // This lets us suppress pure HEARTBEAT_OK acknowledgements end-to-end.
        if (isAssistantMessageEvent && isAssistantMessage) {
          if (item.type === "message_start") {
            const streamId = this.beginStream(conversationId, item);
            this.pendingAssistantStarts.set(streamId, { agentId, conversationId, event: item });
            continue;
          }

          const streamId = this.getActiveStreamId(conversationId, item);
          const isHeartbeatAck = isHeartbeatAckEvent(item);
          if (isHeartbeatAck) {
            if (item.type === "message_end") {
              this.pendingAssistantStarts.delete(streamId);
              this.endStream(conversationId);
            }
            continue;
          }

          const pendingStart = this.pendingAssistantStarts.get(streamId);
          if (pendingStart) {
            this.client.send(targetDeviceId, StreamAction, {
              streamId,
              agentId: pendingStart.agentId,
              conversationId: pendingStart.conversationId,
              sessionId: pendingStart.conversationId,
              event: pendingStart.event,
            });
            this.pendingAssistantStarts.delete(streamId);
          }

          this.client.send(targetDeviceId, StreamAction, {
            streamId,
            agentId,
            conversationId,
            sessionId: conversationId,
            event: item,
          });
          if (item.type === "message_end") {
            this.endStream(conversationId);
          }
          continue;
        }

        const streamId = this.getActiveStreamId(conversationId, item);
        this.client.send(targetDeviceId, StreamAction, {
          streamId,
          agentId,
          conversationId,
          sessionId: conversationId,
          event: item,
        });
      }
    }
  }

  /** Handle RPC request and send response back via Gateway */
  private async handleRpc(from: string, request: RequestPayload): Promise<void> {
    const { requestId, method } = request;
    try {
      const result = await this.rpc.dispatch(method, request.params, from);
      if (method === "createConversation") {
        const createdConversationId = (result as { id?: unknown }).id;
        if (typeof createdConversationId === "string" && createdConversationId) {
          this.deviceStore.allowConversation(from, createdConversationId);
        }
      }
      this.client.send<ResponseSuccessPayload>(from, ResponseAction, {
        requestId,
        ok: true,
        payload: result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RpcError ? err.code : "RPC_ERROR";
      console.error(`[Hub] RPC error: method=${method} code=${code} error=${message}`);
      this.client.send<ResponseErrorPayload>(from, ResponseAction, {
        requestId,
        ok: false,
        error: { code, message },
      });
    }
  }

  /** Create a subagent with specific options (isSubagent, systemPrompt, model) */
  createSubagent(sessionId: string, options: Omit<AgentOptions, "sessionId"> = {}): AsyncAgent {
    const existing = this.agents.get(sessionId);
    if (existing && !existing.closed) {
      return existing;
    }

    const agent = new AsyncAgent({
      ...options,
      sessionId,
      isSubagent: true,
    });
    this.agents.set(agent.sessionId, agent);

    // Subagents are ephemeral — don't persist to agent store
    void this.consumeAgent(agent);

    console.log(`[Hub] Subagent created: ${agent.sessionId}`);
    return agent;
  }

  /**
   * Create an exec approval callback for an agent.
   * This wires the safety evaluation + Hub approval manager together.
   */
  private createExecApprovalCallback(conversationId: string, agentId: string, profileId: string): ExecApprovalCallback {
    return async (command: string, cwd: string | undefined): Promise<ApprovalResult> => {
      // Load exec approval config from profile
      let config: ExecApprovalConfig = {};
      try {
        const profileConfig = readProfileConfig(profileId);
        config = profileConfig?.execApproval ?? {};
      } catch {
        // No profile config, use defaults
      }

      const security = config.security ?? "full";
      const ask = config.ask ?? "off";

      // Security: deny blocks everything
      if (security === "deny") {
        return { approved: false, decision: "deny" };
      }

      // Security: full allows everything
      if (security === "full") {
        return { approved: true, decision: "allow-once" };
      }

      // Evaluate safety
      const evaluation = evaluateCommandSafety(command, config);

      // Check if approval is needed
      const needsApproval = requiresApproval({
        ask,
        security,
        analysisOk: evaluation.analysisOk,
        allowlistSatisfied: evaluation.allowlistSatisfied,
      });

      if (!needsApproval) {
        // Record allowlist usage
        if (evaluation.allowlistSatisfied) {
          const match = matchAllowlist(config.allowlist ?? [], command);
          if (match) {
            try {
              const profileConfig = readProfileConfig(profileId) ?? {};
              const updated = recordAllowlistUse(profileConfig.execApproval?.allowlist ?? [], match, command);
              writeProfileConfig(profileId, { ...profileConfig, execApproval: { ...config, allowlist: updated } });
            } catch {
              // Non-critical: don't fail command for usage recording
            }
          }
        }
        return { approved: true, decision: "allow-once" };
      }

      // Request approval via Hub → Gateway → Client
      const result = await this.approvalManager.requestApproval({
        agentId,
        conversationId,
        command,
        ...(cwd !== undefined ? { cwd } : {}),
        riskLevel: evaluation.riskLevel,
        riskReasons: evaluation.reasons,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.askFallback !== undefined ? { askFallback: config.askFallback } : {}),
        ...(evaluation.allowlistSatisfied !== undefined ? { allowlistSatisfied: evaluation.allowlistSatisfied } : {}),
      });

      // Handle allow-always: persist to profile allowlist
      if (result.decision === "allow-always") {
        try {
          const profileConfig = readProfileConfig(profileId) ?? {};
          const currentAllowlist = profileConfig.execApproval?.allowlist ?? [];
          // Extract binary pattern for allowlist
          const binary = command.trim().split(/\s+/)[0];
          const pattern = binary ? `${binary} **` : command;
          const updated = addAllowlistEntry(currentAllowlist, pattern);
          writeProfileConfig(profileId, {
            ...profileConfig,
            execApproval: { ...config, allowlist: updated },
          });
        } catch {
          // Non-critical: command still allowed even if persistence fails
        }
      }

      return result;
    };
  }

  /**
   * Create a callback for the send_file tool that routes files through
   * the channel plugin (local) or gateway (remote) path.
   */
  private createChannelSendFileCallback(sessionId: string): (filePath: string, caption: string | undefined, type: string) => Promise<boolean> {
    return async (filePath: string, caption: string | undefined, type: string): Promise<boolean> => {
      // Path 1: Channel plugin (local bot — file on same machine)
      const sentViaChannel = await this.channelManager.sendFile(filePath, caption, type);
      if (sentViaChannel) return true;

      // Path 2: Gateway (remote bot — read file, base64 encode, send via RoutedMessage)
      const deviceId = this.agentSenders.get(sessionId);
      if (deviceId) {
        try {
          const fileBuffer = await readFile(filePath);
          this.client.send(deviceId, "send_file", {
            data: fileBuffer.toString("base64"),
            type,
            caption,
            filename: basename(filePath),
            conversationId: sessionId,
            sessionId,
          });
          console.log(`[Hub] Sent file via gateway: ${basename(filePath)} → ${deviceId}`);
          return true;
        } catch (err) {
          console.error(`[Hub] Failed to send file via gateway: ${err}`);
          return false;
        }
      }

      return false;
    };
  }

  getAgent(id: string): AsyncAgent | undefined {
    const normalizedId = this.normalizeId(id);
    if (!normalizedId) return undefined;

    const directConversation = this.agents.get(normalizedId);
    if (directConversation && !directConversation.closed) {
      return directConversation;
    }

    const mainConversationId = this.resolveAgentMainConversationId(normalizedId);
    if (!mainConversationId) return undefined;
    const mainConversation = this.agents.get(mainConversationId);
    if (!mainConversation || mainConversation.closed) return undefined;
    return mainConversation;
  }

  getConversation(id: string): AsyncAgent | undefined {
    const normalizedId = this.normalizeId(id);
    if (!normalizedId) return undefined;
    const conversation = this.agents.get(normalizedId);
    if (!conversation || conversation.closed) return undefined;
    return conversation;
  }

  getConversationAgentId(conversationId: string): string | undefined {
    const normalizedConversationId = this.normalizeId(conversationId);
    if (!normalizedConversationId) return undefined;
    return this.conversationAgents.get(normalizedConversationId);
  }

  getAgentMainConversationId(agentId: string): string | undefined {
    const normalizedAgentId = this.normalizeId(agentId);
    if (!normalizedAgentId) return undefined;
    return this.resolveAgentMainConversationId(normalizedAgentId);
  }

  listAgents(): string[] {
    const activeAgentIds = new Set<string>();
    for (const [conversationId, runtime] of this.agents.entries()) {
      if (runtime.closed) continue;
      const agentId = this.conversationAgents.get(conversationId);
      if (agentId) {
        activeAgentIds.add(agentId);
      }
    }
    return Array.from(activeAgentIds.values());
  }

  listConversations(): string[] {
    return Array.from(this.agents.entries())
      .filter(([conversationId, runtime]) => !runtime.closed && this.conversationAgents.has(conversationId))
      .map(([conversationId]) => conversationId);
  }

  /** Subscribe heartbeat state updates. Returns unsubscribe callback. */
  onHeartbeatEvent(callback: (event: HeartbeatEventPayload) => void): () => void {
    this.heartbeatListeners.add(callback);
    return () => {
      this.heartbeatListeners.delete(callback);
    };
  }

  /** Get latest heartbeat event payload. */
  getLastHeartbeat(): HeartbeatEventPayload | null {
    return getLastHeartbeatEvent();
  }

  /** Enable/disable heartbeat runner globally. */
  setHeartbeatsEnabled(enabled: boolean): void {
    setHeartbeatsEnabled(enabled);
    this.heartbeatRunner?.updateConfig();
  }

  /** Enqueue a heartbeat wake request. */
  requestHeartbeatNow(opts?: { reason?: string }): void {
    requestHeartbeatNow(opts);
  }

  /** Run heartbeat immediately using the current default agent. */
  async runHeartbeatOnce(opts?: { reason?: string }): Promise<HeartbeatRunResult> {
    const agent = this.getDefaultAgent();
    const reason = opts?.reason;
    const shouldSuppressStreams = reason === "manual";
    if (shouldSuppressStreams && agent) {
      this.suppressedStreamAgents.add(agent.sessionId);
    }

    try {
      if (reason) {
        return runHeartbeatOnce({
          agent,
          reason,
        });
      }
      return runHeartbeatOnce({
        agent,
      });
    } finally {
      if (shouldSuppressStreams && agent) {
        this.suppressedStreamAgents.delete(agent.sessionId);
      }
    }
  }

  /** Enqueue a system event for a specific agent or the default agent. */
  enqueueSystemEvent(text: string, opts?: { agentId?: string }): void {
    const agentId = opts?.agentId ?? this.listAgents()[0];
    const conversationId = this.resolveConversationId(agentId, undefined);
    if (!conversationId) return;
    enqueueSystemEvent(text, { sessionKey: conversationId });
  }

  closeAgent(id: string): boolean {
    const normalizedId = this.normalizeId(id);
    if (!normalizedId) return false;

    const resolvedAgentId = this.agentMainConversations.has(normalizedId)
      ? normalizedId
      : this.conversationAgents.get(normalizedId) ?? normalizedId;
    const conversationIds = this.listConversationIdsForAgent(resolvedAgentId);
    if (conversationIds.length === 0) {
      return this.closeConversation(normalizedId);
    }

    let closedAny = false;
    for (const conversationId of conversationIds) {
      const closed = this.closeConversationRuntime(conversationId, { persist: false });
      closedAny = closedAny || closed.ok;
    }
    if (!closedAny) return false;

    this.agentMainConversations.delete(resolvedAgentId);
    this.agentProfiles.delete(resolvedAgentId);
    removeAgentRecordById(resolvedAgentId);
    this.heartbeatRunner?.updateConfig();
    return closedAny;
  }

  closeConversation(id: string): boolean {
    const normalizedId = this.normalizeId(id);
    if (!normalizedId) return false;
    const conversationId = this.agents.has(normalizedId)
      ? normalizedId
      : this.resolveAgentMainConversationId(normalizedId);
    if (!conversationId) return false;

    const { ok, agentId } = this.closeConversationRuntime(conversationId);
    if (!ok || !agentId) return false;

    const currentMainConversationId = this.agentMainConversations.get(agentId);
    if (currentMainConversationId === conversationId) {
      this.agentMainConversations.delete(agentId);
      const replacementConversationId = this.listConversationIdsForAgent(agentId)[0];
      if (replacementConversationId) {
        this.agentMainConversations.set(agentId, replacementConversationId);
      }
    }

    this.clearAgentIfNoConversation(agentId);
    this.heartbeatRunner?.updateConfig();
    return true;
  }

  shutdown(): void {
    // Stop all channel connections
    this.channelManager.stopAll();

    // Stop cron service
    shutdownCronService();
    this.heartbeatRunner?.stop();
    this.heartbeatRunner = null;
    this.heartbeatUnsubscribe?.();
    this.heartbeatUnsubscribe = null;
    this.heartbeatListeners.clear();

    for (const [conversationId, agent] of this.agents) {
      agent.close();
      this.agents.delete(conversationId);
      this.conversationAgents.delete(conversationId);
      this.agentSenders.delete(conversationId);
      this.agentStreamIds.delete(conversationId);
      this.agentStreamCounters.delete(conversationId);
      this.clearPendingAssistantStarts(conversationId);
      this.suppressedStreamAgents.delete(conversationId);
      this.localApprovalHandlers.delete(conversationId);
    }
    this.agentMainConversations.clear();
    this.agentProfiles.clear();
    this.client.disconnect();
    console.log("Hub shut down");
  }
}
