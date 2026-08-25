"use client";

/**
 * Client-side watchdog for the connection to the web server hosting the panel. The
 * in-memory state deliberately LATCHES: once the server is marked unreachable it
 * never flips back to "connected" on its own.
 */

export type ServerConnectionState = "connected" | "disconnected";

/**
 * The ONE user-facing sentence for anything the panel refuses (or loses) because
 * the web server can't be reached.
 */
export const SERVER_UNREACHABLE_MESSAGE =
  "Can’t reach the server — navigation and actions are paused until the connection is back.";

/**
 * Thrown in place of whatever low-level failure actually happened when a
 * same-origin request dies because the server is gone.
 */
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

/**
 * True once the state has latched — i.e. the notification is up, navigation is
 * paused, and any request a client fires can only fail.
 */
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
    // Behind a reverse proxy (e.g. Cloudflare) a dead origin still produces an
    // HTTP response — the proxy's 502 error page — so only 2xx counts.
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

/**
 * Verify the panel's web server is reachable; two consecutive failed pings
 * latch the state into "disconnected". Concurrent callers share the one
 * in-flight check.
 */
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
      // A network failure was reported while this check was mid-flight: its
      // first ping may have passed BEFORE the outage, so its "all good" verdict
      // can be stale. Run one more full check instead of dropping the report.
      if (recheckAfterInFlight) {
        recheckAfterInFlight = false;
        if (state === "connected") void checkServerConnection();
      }
    }
  })();
  return inFlightCheck;
}

/**
 * Single reachability probe for the auto-reconnect loop the guard runs while
 * locked.
 */
export function probeServerReachable(): Promise<boolean> {
  return ping();
}

/**
 * For data-layer clients: a same-origin request just failed at the network
 * level, so trigger an immediate (still double-checked) connection check.
 */
export function reportServerUnreachable(): void {
  if (inFlightCheck) {
    recheckAfterInFlight = true;
    return;
  }
  void checkServerConnection();
}

/**
 * Test-only: wait out any check still in flight — so its delayed second ping can't
 * latch a LATER test — then drop the latch, leaving a clean "connected" module.
 */
export async function __resetServerConnectionForTests(): Promise<void> {
  // A check's `finally` can chain one more (the recheck), so drain until none.
  while (inFlightCheck) await inFlightCheck;
  state = "connected";
  inFlightCheck = null;
  recheckAfterInFlight = false;
  listeners.clear();
}
