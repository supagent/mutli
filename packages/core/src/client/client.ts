import { io, Socket } from "socket.io-client";
import { v7 as uuidv7 } from "uuid";
import type {
  GatewayClientOptions,
  GatewayClientCallbacks,
  ConnectionState,
  RoutedMessage,
  RegisteredResponse,
  SendErrorResponse,
  PingPayload,
  DeviceType,
  DeviceInfo,
  ListDevicesResponse,
} from "./types";
import { GatewayEvents } from "./types";
import {
  RequestAction,
  ResponseAction,
  type RequestPayload,
  type ResponsePayload,
  isResponseSuccess,
} from "./actions/rpc";

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResolvedOptions {
  url: string;
  path: string;
  deviceId: string;
  deviceType: DeviceType;
  autoReconnect: boolean;
  reconnectDelay: number;
  hubId: string | undefined;
  token: string | undefined;
  verifyTimeout: number;
}

export class GatewayClient {
  private socket: Socket | null = null;
  private options: ResolvedOptions;
  private callbacks: GatewayClientCallbacks = {};
  private _state: ConnectionState = "disconnected";
  private pendingRequests = new Map<string, PendingRequest>();

  constructor(options: GatewayClientOptions) {
    if (!options.deviceId) {
      throw new Error("deviceId is required");
    }

    this.options = {
      url: options.url,
      path: options.path ?? "/ws",
      deviceId: options.deviceId,
      deviceType: options.deviceType,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelay: options.reconnectDelay ?? 1000,
      hubId: options.hubId,
      token: options.token,
      verifyTimeout: options.verifyTimeout ?? 30_000,
    };
  }

  /** 当前连接状态 */
  get state(): ConnectionState {
    return this._state;
  }

  /** 设备ID */
  get deviceId(): string {
    return this.options.deviceId;
  }

  /** 设备类型 */
  get deviceType(): DeviceType {
    return this.options.deviceType;
  }

  /** Socket ID（连接后可用） */
  get socketId(): string | undefined {
    return this.socket?.id;
  }

  /** 是否已连接 */
  get isConnected(): boolean {
    return this._state === "connected" || this._state === "registered";
  }

  /** 是否已注册 */
  get isRegistered(): boolean {
    return this._state === "registered";
  }

  /** 连接到服务器，deviceId 和 deviceType 通过 query 传递 */
  connect(): this {
    if (this.socket) {
      return this;
    }

    this.setState("connecting");

    const query: Record<string, string> = {
      deviceId: this.options.deviceId,
      deviceType: this.options.deviceType,
    };

    this.socket = io(this.options.url, {
      path: this.options.path,
      query,
      reconnection: this.options.autoReconnect,
      reconnectionDelay: this.options.reconnectDelay,
    });

    this.setupListeners();
    return this;
  }

  /** 断开连接 */
  disconnect(): this {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.setState("disconnected");
    return this;
  }

  /** 发送消息给指定设备 */
  send<T = unknown>(
    to: string,
    action: string,
    payload: T,
    messageId?: string
  ): string {
    if (!this.socket || !this.isRegistered) {
      throw new Error("Not registered");
    }

    const id = messageId ?? this.generateMessageId();
    const message: RoutedMessage<T> = {
      id,
      uid: null,
      from: this.options.deviceId,
      to,
      action,
      payload,
    };

    this.socket.emit(GatewayEvents.SEND, message);
    return id;
  }

  /** 发送 ping */
  ping(data: PingPayload = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isConnected) {
        reject(new Error("Not connected"));
        return;
      }

      this.socket.emit(
        GatewayEvents.PING,
        data,
        (response: { event: string; data: string }) => {
          resolve(response.data);
        }
      );
    });
  }

  /** List all devices connected to the Gateway */
  listDevices(): Promise<DeviceInfo[]> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isRegistered) {
        reject(new Error("Not registered"));
        return;
      }

      this.socket.emit(
        GatewayEvents.LIST_DEVICES,
        {},
        (response: ListDevicesResponse) => {
          resolve(response.devices);
        }
      );
    });
  }

  /** Send an RPC request and wait for the response */
  request<T = unknown>(
    to: string,
    method: string,
    params?: unknown,
    timeout = 10_000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.socket || !this.isRegistered) {
        reject(new Error("Not registered"));
        return;
      }

      const requestId = this.generateMessageId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`RPC request timed out: ${method}`));
      }, timeout);

      this.pendingRequests.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });

      const payload: RequestPayload = { requestId, method, params };
      this.send(to, RequestAction, payload);
    });
  }

  /** 注册连接回调 */
  onConnect(callback: (socketId: string) => void): this {
    this.callbacks.onConnect = callback;
    return this;
  }

  /** 注册断开回调 */
  onDisconnect(callback: (reason: string) => void): this {
    this.callbacks.onDisconnect = callback;
    return this;
  }

  /** 注册成功回调 */
  onRegistered(callback: (deviceId: string) => void): this {
    this.callbacks.onRegistered = callback;
    return this;
  }

  /** Hub 验证成功回调 */
  onVerified(
    callback: (
      result: {
        hubId: string;
        agentId: string;
        conversationId?: string;
        sessionId?: string;
        mainConversationId?: string;
        isNewDevice?: boolean;
      }
    ) => void,
  ): this {
    this.callbacks.onVerified = callback;
    return this;
  }

  /** 注册消息回调 */
  onMessage(callback: (message: RoutedMessage) => void): this {
    this.callbacks.onMessage = callback;
    return this;
  }

  /** 注册发送失败回调 */
  onSendError(callback: (error: SendErrorResponse) => void): this {
    this.callbacks.onSendError = callback;
    return this;
  }

  /** 注册 pong 回调 */
  onPong(callback: (data: string) => void): this {
    this.callbacks.onPong = callback;
    return this;
  }

  /** 注册错误回调 */
  onError(callback: (error: Error) => void): this {
    this.callbacks.onError = callback;
    return this;
  }

  /** 注册状态变化回调 */
  onStateChange(callback: (state: ConnectionState) => void): this {
    this.callbacks.onStateChange = callback;
    return this;
  }

  private setState(state: ConnectionState): void {
    if (this._state !== state) {
      this._state = state;
      this.callbacks.onStateChange?.(state);
    }
  }

  private generateMessageId(): string {
    return uuidv7();
  }

  private setupListeners(): void {
    if (!this.socket) return;

    this.socket.on("connect", () => {
      this.setState("connected");
      this.callbacks.onConnect?.(this.socket!.id!);
      // 服务端在连接时从 query 自动注册，等待 registered 事件即可
    });

    this.socket.on("disconnect", (reason: string) => {
      this.setState("disconnected");
      // Reject all pending RPC requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Disconnected"));
      }
      this.pendingRequests.clear();
      this.callbacks.onDisconnect?.(reason);
    });

    this.socket.on(
      GatewayEvents.REGISTERED,
      (response: RegisteredResponse) => {
        if (!response.success) {
          this.callbacks.onError?.(new Error(response.error ?? "Registration failed"));
          return;
        }

        // If hubId is configured, auto-verify before exposing "registered" to upper layer
        if (this.options.hubId) {
          // Set internal state to allow send/request during verify
          this._state = "registered";
          this.callbacks.onStateChange?.("verifying");
          const meta = typeof navigator !== "undefined" ? {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            language: navigator.language,
          } : undefined;
            this.request<{
              hubId: string;
              agentId: string;
              conversationId?: string;
              sessionId?: string;
              mainConversationId?: string;
              isNewDevice?: boolean;
            }>(
              this.options.hubId,
              "verify",
              { token: this.options.token, meta },
              this.options.verifyTimeout,
            )
            .then((result) => {
              const sessionId = result.sessionId ?? result.conversationId ?? result.mainConversationId;
              const normalizedResult = {
                ...result,
                ...(sessionId ? { sessionId, conversationId: sessionId, mainConversationId: sessionId } : {}),
              };
              // Verify succeeded — now expose "registered" to upper layer
              this.callbacks.onVerified?.(normalizedResult);
              this.callbacks.onRegistered?.(response.deviceId);
              this.callbacks.onStateChange?.("registered");
            })
            .catch((err) => {
              // Verify failed (UNAUTHORIZED, REJECTED, or timeout)
              this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
              this.disconnect();
            });
        } else {
          // No hubId — original behavior
          this.setState("registered");
          this.callbacks.onRegistered?.(response.deviceId);
        }
      }
    );

    this.socket.on(GatewayEvents.RECEIVE, (message: RoutedMessage) => {
      // Intercept RPC responses and resolve pending requests
      if (message.action === ResponseAction) {
        const response = message.payload as ResponsePayload;
        const pending = this.pendingRequests.get(response.requestId);
        if (pending) {
          this.pendingRequests.delete(response.requestId);
          clearTimeout(pending.timer);
          if (isResponseSuccess(response)) {
            pending.resolve(response.payload);
          } else {
            pending.reject(new Error(`RPC error [${response.error.code}]: ${response.error.message}`));
          }
          return;
        }
      }
      this.callbacks.onMessage?.(message);
    });

    this.socket.on(GatewayEvents.SEND_ERROR, (error: SendErrorResponse) => {
      this.callbacks.onSendError?.(error);
    });

    this.socket.on(GatewayEvents.PONG, (data: string) => {
      this.callbacks.onPong?.(data);
    });

    this.socket.on("connect_error", (error: Error) => {
      this.callbacks.onError?.(error);
    });
  }
}
