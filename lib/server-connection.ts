"use client";

export type ServerConnectionState = "connected" | "disconnected";

export const SERVER_UNREACHABLE_MESSAGE =
  "Can’t reach the server - navigation and actions are paused until the connection is back.";

export class ServerUnreachableError extends Error {
  constructor(message: string = SERVER_UNREACHABLE_MESSAGE) {
    super(message);
    this.name = "ServerUnreachableError";
  }
}

const PING_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 1_500;

let state: ServerConnectionState = "connected";
let inFlightCheck: Promise<void> | null = null;
let recheckAfterInFlight = false;
const listeners = new Set<() => void>();

export function subscribeServerConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getServerConnectionSnapshot(): ServerConnectionState {
  return state;
}

export function isServerDisconnected(): boolean {
  return state === "disconnected";
}

async function ping(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", {
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function markDisconnected(): void {
  if (state === "disconnected") return;
  state = "disconnected";
  for (const listener of listeners) listener();
}

export function checkServerConnection(): Promise<void> {
  if (state === "disconnected") return Promise.resolve();
  inFlightCheck ??= (async () => {
    try {
      if (await ping()) return;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (await ping()) return;
      markDisconnected();
    } finally {
      inFlightCheck = null;
      if (recheckAfterInFlight) {
        recheckAfterInFlight = false;
        if (state === "connected") void checkServerConnection();
      }
    }
  })();
  return inFlightCheck;
}

export function probeServerReachable(): Promise<boolean> {
  return ping();
}

export function reportServerUnreachable(): void {
  if (inFlightCheck) {
    recheckAfterInFlight = true;
    return;
  }
  void checkServerConnection();
}

export async function __resetServerConnectionForTests(): Promise<void> {
  while (inFlightCheck) await inFlightCheck;
  state = "connected";
  inFlightCheck = null;
  recheckAfterInFlight = false;
  listeners.clear();
}
