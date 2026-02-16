/** WebSocket event names */
export const GatewayEvents = {
  // System events
  PING: "ping",
  PONG: "pong",
  REGISTERED: "registered",
  LIST_DEVICES: "list-devices",

  // Message routing
  SEND: "send",
  RECEIVE: "receive",
  SEND_ERROR: "send_error",
} as const;

// ============ Device Related ============

/** Device type */
export type DeviceType = "client" | "hub" | "agent";

/** Device information */
export interface DeviceInfo {
  deviceId: string;
  deviceType: DeviceType;
}

/** Registration response */
export interface RegisteredResponse {
  success: boolean;
  deviceId: string;
  error?: string;
}

// ============ Message Routing ============

/** Routed message */
export interface RoutedMessage<T = unknown> {
  /** Unique message ID (UUID v7, contains timestamp) */
  id: string;
  /** User ID (populated after login) */
  uid: string | null;
  /** Sender deviceId */
  from: string;
  /** Recipient deviceId */
  to: string;
  /** Action type */
  action: string;
  /** Message payload */
  payload: T;
}

/** Send failure response */
export interface SendErrorResponse {
  messageId: string;
  error: string;
  code: "DEVICE_NOT_FOUND" | "NOT_REGISTERED" | "INVALID_MESSAGE";
}

/** List devices response */
export interface ListDevicesResponse {
  devices: DeviceInfo[];
}

// ============ Ping/Pong ============

/** Ping request */
export interface PingPayload {
  [key: string]: unknown;
}

/** Ping response */
export interface PongResponse {
  event: string;
  data: string;
}

// ============ Client Configuration ============

/** Connection configuration */
export interface GatewayClientOptions {
  /** Server address, e.g. http://localhost:3000 */
  url: string;
  /** WebSocket path, defaults to /ws */
  path?: string | undefined;
  /** Device ID */
  deviceId: string;
  /** Device type */
  deviceType: DeviceType;
  /** Auto reconnect, defaults to true */
  autoReconnect?: boolean | undefined;
  /** Reconnect delay (milliseconds), defaults to 1000 */
  reconnectDelay?: number | undefined;
  /** Hub device ID for verification (optional, enables auto-verify after gateway registration) */
  hubId?: string | undefined;
  /** Token for first-time verification (optional, omit for reconnection via device whitelist) */
  token?: string | undefined;
  /** Verify timeout in ms (default: 30_000, longer because user confirmation may be needed) */
  verifyTimeout?: number | undefined;
}

/** Connection state */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "verifying"
  | "registered";

/** Event callback types */
export interface GatewayClientCallbacks {
  onConnect?: (socketId: string) => void;
  onDisconnect?: (reason: string) => void;
  onRegistered?: (deviceId: string) => void;
  onVerified?: (
    result: {
      hubId: string;
      agentId: string;
      conversationId?: string;
      sessionId?: string;
      mainConversationId?: string;
      isNewDevice?: boolean;
    }
  ) => void;
  onMessage?: (message: RoutedMessage) => void;
  onSendError?: (error: SendErrorResponse) => void;
  onPong?: (data: string) => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: ConnectionState) => void;
}
