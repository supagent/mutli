"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  GatewayClient,
  type ConnectionState,
} from "@multica/sdk";

// Persisted connection identity (separate from one-time token)
const STORAGE_KEY = "multica-connection-identity";
const DEVICE_KEY = "multica-device-id";

export interface ConnectionIdentity {
  gateway: string;
  hubId: string;
  agentId: string;
  conversationId?: string;
}

function loadIdentity(): ConnectionIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed.gateway
      && parsed.hubId
      && parsed.agentId
      && (parsed.conversationId === undefined || typeof parsed.conversationId === "string")
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveIdentity(identity: ConnectionIdentity): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

function clearIdentity(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// SHA-256 hash (Web Crypto API)
async function sha256(text: string): Promise<string> {
  const buffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Generate encrypted device ID (40 hex chars, consistent with copilot-search)
async function generateEncryptedDeviceId(): Promise<string> {
  const uuid = crypto.randomUUID();
  const firstHash = (await sha256(uuid)).slice(0, 32);
  return (await sha256(firstHash)).slice(0, 8) + firstHash;
}

// Validate encrypted ID format (40 hex characters)
function isValidEncryptedId(id: string): boolean {
  return typeof id === "string" && /^[a-f0-9]{40}$/i.test(id);
}

// Cached promise for device ID generation
let deviceIdPromise: Promise<string> | null = null;

async function getDeviceId(): Promise<string> {
  const existing = localStorage.getItem(DEVICE_KEY);
  // If already encrypted format, return as-is
  if (existing && isValidEncryptedId(existing)) {
    return existing;
  }
  // Generate new encrypted ID (or migrate old UUID)
  if (!deviceIdPromise) {
    deviceIdPromise = generateEncryptedDeviceId().then((id) => {
      localStorage.setItem(DEVICE_KEY, id);
      return id;
    });
  }
  return deviceIdPromise;
}

export type PageState = "loading" | "not-connected" | "connecting" | "connected";

export interface UseGatewayConnectionReturn {
  pageState: PageState;
  /** Raw SDK connection state — used by ConnectAgent for verifying/connecting distinction */
  connectionState: ConnectionState;
  identity: ConnectionIdentity | null;
  error: string | null;
  client: GatewayClient | null;
  /** Increments on each disconnect — use as React key to reset child components */
  pairingKey: number;
  connect: (identity: ConnectionIdentity, token?: string) => void;
  disconnect: () => void;
}

export function useGatewayConnection(): UseGatewayConnectionReturn {
  const [pageState, setPageState] = useState<PageState>("loading");
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [identity, setIdentity] = useState<ConnectionIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<GatewayClient | null>(null);
  const verifiedIdentityRef = useRef<ConnectionIdentity | null>(null);
  const disconnectingRef = useRef(false);
  const pairingKeyRef = useRef(0);

  const connectToGateway = useCallback(
    (id: ConnectionIdentity, token?: string) => {
      const doConnect = async () => {
        disconnectingRef.current = false;
        setPageState("connecting");
        setError(null);

        const deviceId = await getDeviceId();

        const client = new GatewayClient({
          url: id.gateway,
          deviceId,
          deviceType: "client",
          hubId: id.hubId,
          ...(token ? { token } : {}),
        })
          .onVerified((result) => {
            if (disconnectingRef.current) return;
            verifiedIdentityRef.current = {
              gateway: id.gateway,
              hubId: result.hubId,
              agentId: result.agentId,
              conversationId:
                id.conversationId
                ?? result.sessionId
                ?? result.conversationId
                ?? result.mainConversationId
                ?? result.agentId,
            };
          })
          .onStateChange((state: ConnectionState) => {
            console.log("[GatewayConnection] state:", state);
            if (disconnectingRef.current) return;
            setConnectionState(state);
            if (state === "registered") {
              const resolvedIdentity = verifiedIdentityRef.current ?? id;
              saveIdentity(resolvedIdentity);
              setIdentity(resolvedIdentity);
              setPageState("connected");
            }
          })
          .onError((err: Error) => {
            console.log("[GatewayConnection] error:", err.message);
            if (disconnectingRef.current) return;
            pairingKeyRef.current += 1;
            verifiedIdentityRef.current = null;
            clearIdentity();
            setIdentity(null);
            setError(err.message);
            setPageState("not-connected");
            clientRef.current?.disconnect();
            clientRef.current = null;
          })
          .onSendError((err) => {
            if (disconnectingRef.current) return;
            setError(err.error);
          });

        clientRef.current = client;
        client.connect();
      };

      // If there's an existing client, disconnect first and wait for Gateway to process
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
        verifiedIdentityRef.current = null;
        setTimeout(doConnect, 300);
      } else {
        verifiedIdentityRef.current = null;
        doConnect();
      }
    },
    [],
  );

  // Try to reconnect with saved identity on mount
  useEffect(() => {
    const saved = loadIdentity();
    console.log("[GatewayConnection] mount, saved identity:", saved);
    if (!saved) {
      setPageState("not-connected");
      return;
    }

    setIdentity(saved);
    // Delay reconnection — if a previous socket just disconnected (e.g. StrictMode
    // cleanup or page navigation), the Gateway needs time to process it
    const timer = setTimeout(() => connectToGateway(saved), 300);

    return () => {
      clearTimeout(timer);
      clientRef.current?.disconnect();
      clientRef.current = null;
      verifiedIdentityRef.current = null;
    };
  }, []);

  const disconnect = useCallback(() => {
    disconnectingRef.current = true;
    pairingKeyRef.current += 1;
    clientRef.current?.disconnect();
    clientRef.current = null;
    verifiedIdentityRef.current = null;
    clearIdentity();
    setIdentity(null);
    setPageState("not-connected");
    setConnectionState("disconnected");
    setError(null);
  }, []);

  return {
    pageState,
    connectionState,
    identity,
    error,
    client: clientRef.current,
    pairingKey: pairingKeyRef.current,
    connect: connectToGateway,
    disconnect,
  };
}
