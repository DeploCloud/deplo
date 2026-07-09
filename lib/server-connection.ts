"use client";

/**
 * Client-side watchdog for the connection to the web server hosting the panel.
 *
 * The in-memory state deliberately LATCHES: once the server is marked
 * unreachable it never flips back to "connected" on its own. Recovery always
 * goes through a full page reload — never an in-place un-latch — because a
 * reload is what guarantees a clean slate: dropped SSE subscriptions
 * resubscribe and any stale in-memory data is re-read from the server.
 *
 * That reload is no longer purely manual, though. While locked, the
 * ServerConnectionGuard overlay both probes for the server's return
 * (`probeServerReachable`, the auto-reconnect loop) and reloads the moment it
 * answers, on top of still offering a manual "Reload page" button.
 *
 * Detection has two feeds:
 *  - a periodic heartbeat (driven by ServerConnectionGuard) calling
 *    `checkServerConnection`;
 *  - data-layer clients calling `reportServerUnreachable` the moment a
 *    same-origin request fails at the network level, so the UI locks
 *    immediately instead of waiting for the next heartbeat tick.
 *
 * A single failed ping is never trusted: the check retries once after a short
 * delay so a transient blip doesn't freeze the whole panel.
 */

export type ServerConnectionState = "connected" | "disconnected";

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
 * locked. Unlike `checkServerConnection` this neither retries nor latches the
 * state: a lone success is enough of a signal for the caller (the overlay) to
 * reload the page, and the freshly-loaded panel re-verifies the connection from
 * scratch — so a server that answered one probe then flapped is caught again.
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
