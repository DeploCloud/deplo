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

// isServerDisconnected - true once the state has latched: navigation is paused and any request can only fail.
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
    // Behind a reverse proxy a dead origin still returns an HTTP response (the proxy's 502 page), so only 2xx counts.
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

// checkServerConnection - two consecutive failed pings latch "disconnected"; concurrent callers share one in-flight check.
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
      // A failure reported mid-check can make this check's verdict stale, so run one more instead of dropping the report.
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

// reportServerUnreachable - a same-origin request just failed at the network level; trigger an immediate check.
export function reportServerUnreachable(): void {
  if (inFlightCheck) {
    recheckAfterInFlight = true;
    return;
  }
  void checkServerConnection();
}

// __resetServerConnectionForTests - drain any check still in flight, then drop the latch.
export async function __resetServerConnectionForTests(): Promise<void> {
  // A check's `finally` can chain one more (the recheck), so drain until none.
  while (inFlightCheck) await inFlightCheck;
  state = "connected";
  inFlightCheck = null;
  recheckAfterInFlight = false;
  listeners.clear();
}
