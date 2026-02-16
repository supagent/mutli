import { ipcRenderer, contextBridge } from 'electron'

// ============================================================================
// Type definitions for IPC API
// ============================================================================

export interface HubStatus {
  hubId: string
  status: string
  agentCount: number
  gatewayConnected: boolean
  gatewayUrl?: string
  defaultAgent?: {
    agentId: string
    status: string
  } | null
}

export interface AgentInfo {
  agentId: string
  status: string
}

export interface ToolInfo {
  name: string
  group: string
  enabled: boolean
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  version: string
  enabled: boolean
  source: 'bundled' | 'global' | 'profile'
  triggers: string[]
}

export interface ProfileData {
  profileId: string | undefined
  name: string | undefined
  userContent: string | undefined
}

export interface ProviderStatus {
  id: string
  name: string
  authMethod: 'api-key' | 'oauth'
  available: boolean
  configured: boolean
  current: boolean
  defaultModel: string
  models: string[]
  loginUrl?: string
  loginCommand?: string
  loginInstructions?: string
}

export interface CurrentProviderInfo {
  provider: string
  model: string | undefined
  providerName: string | undefined
  available: boolean
}

// Local chat event types (for direct IPC communication without Gateway)
export interface LocalChatEvent {
  agentId: string
  conversationId?: string
  sessionId?: string
  streamId?: string
  type?: 'error'
  content?: string
  event?: {
    type: 'message_start' | 'message_update' | 'message_end' | 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end' | 'compaction_start' | 'compaction_end'
    id?: string
    message?: {
      role: string
      content?: Array<{ type: string; text?: string }>
    }
    [key: string]: unknown
  }
}

// Inbound message event (from any source: local, gateway, channel)
export type MessageSource =
  | { type: 'local' }
  | { type: 'gateway'; deviceId: string }
  | { type: 'channel'; channelId: string; accountId: string; conversationId: string }

export interface InboundMessageEvent {
  agentId: string
  conversationId: string
  content: string
  source: MessageSource
  timestamp: number
}

// Local chat approval request (mirrors ExecApprovalRequestPayload from @multica/sdk)
export interface LocalChatApproval {
  approvalId: string
  agentId: string
  conversationId?: string
  sessionId?: string
  command: string
  cwd?: string
  riskLevel: 'safe' | 'needs-review' | 'dangerous'
  riskReasons: string[]
  expiresAtMs: number
}

// ============================================================================
// Expose typed API to Renderer process
// ============================================================================

const electronAPI = {
  // App-level
  app: {
    /** Get CLI flags passed to the app */
    getFlags: (): Promise<{ forceOnboarding: boolean }> => ipcRenderer.invoke('app:getFlags'),
  },

  // App state (persisted to file system)
  appState: {
    /** Get onboarding completed status */
    getOnboardingCompleted: (): Promise<boolean> => ipcRenderer.invoke('appState:getOnboardingCompleted'),
    /** Set onboarding completed status */
    setOnboardingCompleted: (completed: boolean): Promise<void> => ipcRenderer.invoke('appState:setOnboardingCompleted', completed),
  },

  // Auth management
  auth: {
    /** Load auth data from local file */
    load: (): Promise<{ sid: string; user: { uid: string; name: string; email?: string; icon?: string; vip?: number }; deviceId?: string } | null> =>
      ipcRenderer.invoke('auth:load'),
    /** Save auth data to local file (with optional deviceId from Web) */
    save: (sid: string, user: { uid: string; name: string; email?: string; icon?: string; vip?: number }, deviceId?: string): Promise<boolean> =>
      ipcRenderer.invoke('auth:save', sid, user, deviceId),
    /** Clear auth data (logout) */
    clear: (): Promise<boolean> => ipcRenderer.invoke('auth:clear'),
    /** Start login flow (opens browser) */
    startLogin: (): Promise<void> => ipcRenderer.invoke('auth:startLogin'),
    /** Get Device ID (raw UUID) */
    getDeviceId: (): Promise<string> => ipcRenderer.invoke('auth:getDeviceId'),
    /** Get encrypted Device-Id header value for API requests */
    getDeviceIdHeader: (): Promise<string> => ipcRenderer.invoke('auth:getDeviceIdHeader'),
    /** Listen for auth callback (includes deviceId from Web browser) */
    onAuthCallback: (callback: (data: { sid: string; user: { uid: string; name: string; email?: string; icon?: string; vip?: number }; deviceId?: string }) => void) => {
      ipcRenderer.on('auth:callback', (_event, data) => callback(data))
    },
    /** Remove auth callback listener */
    offAuthCallback: () => {
      ipcRenderer.removeAllListeners('auth:callback')
    },
  },

  // Hub management
  hub: {
    init: () => ipcRenderer.invoke('hub:init'),
    getStatus: (): Promise<HubStatus> => ipcRenderer.invoke('hub:getStatus'),
    getAgentInfo: (): Promise<AgentInfo | null> => ipcRenderer.invoke('hub:getAgentInfo'),
    info: () => ipcRenderer.invoke('hub:info'),
    reconnect: (url: string) => ipcRenderer.invoke('hub:reconnect', url),
    listAgents: () => ipcRenderer.invoke('hub:listAgents'),
    listConversations: () => ipcRenderer.invoke('hub:listConversations'),
    createAgent: (id?: string) => ipcRenderer.invoke('hub:createAgent', id),
    createConversation: (id?: string) => ipcRenderer.invoke('hub:createConversation', id),
    getAgent: (id: string) => ipcRenderer.invoke('hub:getAgent', id),
    getConversation: (id: string) => ipcRenderer.invoke('hub:getConversation', id),
    closeAgent: (id: string) => ipcRenderer.invoke('hub:closeAgent', id),
    closeConversation: (id: string) => ipcRenderer.invoke('hub:closeConversation', id),
    sendMessage: (agentId: string, content: string, conversationId?: string) =>
      ipcRenderer.invoke('hub:sendMessage', agentId, content, conversationId),
    registerToken: (token: string, agentId: string, conversationId: string, expiresAt: number) =>
      ipcRenderer.invoke('hub:registerToken', token, agentId, conversationId, expiresAt),
    onDeviceConfirmRequest: (
      callback: (
        deviceId: string,
        agentId: string,
        conversationId: string,
        meta?: { userAgent?: string; platform?: string; language?: string; clientName?: string },
      ) => void,
    ) => {
      ipcRenderer.on(
        'hub:device-confirm-request',
        (
          _event,
          deviceId: string,
          agentId: string,
          conversationId: string,
          meta?: { userAgent?: string; platform?: string; language?: string; clientName?: string },
        ) => callback(deviceId, agentId, conversationId, meta),
      )
    },
    offDeviceConfirmRequest: () => {
      ipcRenderer.removeAllListeners('hub:device-confirm-request')
    },
    deviceConfirmResponse: (deviceId: string, allowed: boolean) => {
      ipcRenderer.send('hub:device-confirm-response', deviceId, allowed)
    },
    listDevices: () => ipcRenderer.invoke('hub:listDevices'),
    revokeDevice: (deviceId: string) => ipcRenderer.invoke('hub:revokeDevice', deviceId),
    onConnectionStateChanged: (callback: (state: string) => void) => {
      ipcRenderer.on('hub:connection-state-changed', (_event, state: string) => callback(state))
    },
    offConnectionStateChanged: () => {
      ipcRenderer.removeAllListeners('hub:connection-state-changed')
    },
    onDevicesChanged: (callback: () => void) => {
      ipcRenderer.on('hub:devices-changed', () => callback())
    },
    offDevicesChanged: () => {
      ipcRenderer.removeAllListeners('hub:devices-changed')
    },
    onInboundMessage: (callback: (event: InboundMessageEvent) => void) => {
      ipcRenderer.on('hub:inbound-message', (_event, data: InboundMessageEvent) => callback(data))
    },
    offInboundMessage: () => {
      ipcRenderer.removeAllListeners('hub:inbound-message')
    },
  },

  // Tools management
  tools: {
    list: (): Promise<ToolInfo[]> => ipcRenderer.invoke('tools:list'),
    toggle: (name: string) => ipcRenderer.invoke('tools:toggle', name),
    setStatus: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('tools:setStatus', name, enabled),
    active: () => ipcRenderer.invoke('tools:active'),
    reload: () => ipcRenderer.invoke('tools:reload'),
  },

  // Skills management
  skills: {
    list: (): Promise<SkillInfo[]> => ipcRenderer.invoke('skills:list'),
    get: (id: string) => ipcRenderer.invoke('skills:get', id),
    toggle: (id: string) => ipcRenderer.invoke('skills:toggle', id),
    setStatus: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('skills:setStatus', id, enabled),
    reload: () => ipcRenderer.invoke('skills:reload'),
    add: (source: string, options?: { name?: string; force?: boolean }) =>
      ipcRenderer.invoke('skills:add', source, options),
    remove: (name: string) => ipcRenderer.invoke('skills:remove', name),
  },

  // Agent management
  agent: {
    status: () => ipcRenderer.invoke('agent:status'),
  },

  // Profile management
  profile: {
    get: (): Promise<ProfileData> => ipcRenderer.invoke('profile:get'),
    updateName: (name: string) => ipcRenderer.invoke('profile:updateName', name),
    updateUser: (content: string) => ipcRenderer.invoke('profile:updateUser', content),
  },

  // Provider management
  provider: {
    /** List all providers with their status */
    list: (): Promise<ProviderStatus[]> => ipcRenderer.invoke('provider:list'),
    /** List only available (configured) providers */
    listAvailable: (): Promise<ProviderStatus[]> => ipcRenderer.invoke('provider:listAvailable'),
    /** Get current provider and model from the active agent */
    current: (): Promise<CurrentProviderInfo> => ipcRenderer.invoke('provider:current'),
    /** Switch the agent to a different provider and/or model */
    set: (providerId: string, modelId?: string): Promise<{ ok: boolean; provider?: string; model?: string; error?: string }> =>
      ipcRenderer.invoke('provider:set', providerId, modelId),
    /** Get metadata for a specific provider */
    getMeta: (providerId: string) => ipcRenderer.invoke('provider:getMeta', providerId),
    /** Check if a specific provider is available */
    isAvailable: (providerId: string): Promise<boolean> => ipcRenderer.invoke('provider:isAvailable', providerId),
    /** Save API key for a provider */
    saveApiKey: (providerId: string, apiKey: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('provider:saveApiKey', providerId, apiKey),
    /** Import OAuth credentials from CLI tools (claude-code, codex) */
    importOAuth: (providerId: string): Promise<{ ok: boolean; expiresAt?: number; error?: string }> =>
      ipcRenderer.invoke('provider:importOAuth', providerId),
    /** Test a provider connection with a minimal prompt */
    test: (providerId: string, modelId?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('provider:test', providerId, modelId),
  },

  // Channel management (Telegram, Discord, etc.)
  channels: {
    /** List all channel account states */
    listStates: () => ipcRenderer.invoke('channels:listStates'),
    /** Get channels config from credentials.json5 */
    getConfig: () => ipcRenderer.invoke('channels:getConfig'),
    /** Save a channel token and start the bot immediately */
    saveToken: (channelId: string, accountId: string, token: string) =>
      ipcRenderer.invoke('channels:saveToken', channelId, accountId, token),
    /** Remove a channel token and stop the bot */
    removeToken: (channelId: string, accountId: string) =>
      ipcRenderer.invoke('channels:removeToken', channelId, accountId),
    /** Stop a channel account */
    stop: (channelId: string, accountId: string) =>
      ipcRenderer.invoke('channels:stop', channelId, accountId),
    /** Start a channel account from saved config */
    start: (channelId: string, accountId: string) =>
      ipcRenderer.invoke('channels:start', channelId, accountId),
  },

  // Cron jobs management
  cron: {
    list: () => ipcRenderer.invoke('cron:list'),
    toggle: (jobId: string) => ipcRenderer.invoke('cron:toggle', jobId),
    remove: (jobId: string) => ipcRenderer.invoke('cron:remove', jobId),
  },

  heartbeat: {
    last: () => ipcRenderer.invoke('heartbeat:last'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('heartbeat:setEnabled', enabled),
    wake: (reason?: string) => ipcRenderer.invoke('heartbeat:wake', reason),
  },

  // Auto-update
  update: {
    /** Check for updates */
    check: () => ipcRenderer.invoke('update:check'),
    /** Download the available update */
    download: () => ipcRenderer.invoke('update:download'),
    /** Quit and install the downloaded update */
    install: () => ipcRenderer.invoke('update:install'),
    /** Listen for update status changes (returns unsubscribe function) */
    onStatus: (callback: (status: { status: string; info?: unknown; progress?: unknown; error?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]): void => {
        callback(status)
      }
      ipcRenderer.on('update:status', listener)
      return (): void => {
        ipcRenderer.removeListener('update:status', listener)
      }
    },
  },

  // Local chat (direct IPC, no Gateway required)
  localChat: {
    /** Subscribe to agent events for local direct chat */
    subscribe: (agentId: string) => ipcRenderer.invoke('localChat:subscribe', agentId),
    /** Unsubscribe from agent events */
    unsubscribe: (agentId: string) => ipcRenderer.invoke('localChat:unsubscribe', agentId),
    /** Get message history for local chat with pagination (returns raw AgentMessageItem[]) */
    getHistory: (agentId: string, options?: { offset?: number; limit?: number; conversationId?: string }) =>
      ipcRenderer.invoke('localChat:getHistory', agentId, options),
    /** Send message to agent via direct IPC (no Gateway) */
    send: (agentId: string, content: string, conversationId?: string) =>
      ipcRenderer.invoke('localChat:send', agentId, content, conversationId),
    /** Abort the current agent run */
    abort: (agentId: string, conversationId?: string) =>
      ipcRenderer.invoke('localChat:abort', agentId, conversationId),
    /** Resolve an exec approval request */
    resolveExecApproval: (approvalId: string, decision: string) =>
      ipcRenderer.invoke('localChat:resolveExecApproval', approvalId, decision),
    /** Listen for agent events */
    onEvent: (callback: (event: LocalChatEvent) => void) => {
      ipcRenderer.on('localChat:event', (_event, data: LocalChatEvent) => callback(data))
    },
    /** Remove event listener */
    offEvent: () => {
      ipcRenderer.removeAllListeners('localChat:event')
    },
    /** Listen for exec approval requests */
    onApproval: (callback: (approval: LocalChatApproval) => void) => {
      ipcRenderer.on('localChat:approval', (_event, data: LocalChatApproval) => callback(data))
    },
    /** Remove approval listener */
    offApproval: () => {
      ipcRenderer.removeAllListeners('localChat:approval')
    },
  },
}

// Expose to renderer
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Also expose ipcRenderer for backward compatibility
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
})

// Type declaration for window object
export type ElectronAPI = typeof electronAPI
