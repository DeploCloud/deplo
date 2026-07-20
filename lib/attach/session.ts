import "server-only";

import { randomBytes } from "node:crypto";
import { type AttachHandle } from "../infra/docker";

/**
 * In-process registry of live `docker attach` sessions.
 *
 * Interactive attach is full-duplex, but the dashboard has no WebSocket layer —
 * so the two directions ride separate HTTP requests against one shared child:
 *   - GET  streams the child's stdout/stderr (PID 1 output) to the browser
 *   - POST writes a keystroke chunk to the same child's stdin
 * A session id ties them together. The child is owned here, not by either
 * request, so a POST can reach the stdin of the process the GET is draining.
 *
 * The backing handle is BUILT BY THE CALLER and passed in (PLAN Part C): it is
 * the owning agent's bidi `Attach` stream adapted to the AttachHandle shape (the
 * pty lives Go-side now), for every project including the host running Deplo. An
 * optional `cleanup` (closing the agent's gRPC client) is bound atomically into
 * the exit path here.
 *
 * This map is module-level singleton state: it survives across requests within
 * one server process. It is NOT shared across a multi-process/clustered
 * deployment — Deplo runs as a single Node server against one Docker socket, so
 * a request for a session always lands on the process that owns it.
 */

export interface AttachSession {
  id: string;
  /** App that authorised this session — POST/GET must match it. */
  appId: string;
  /** Real container name being attached. */
  containerName: string;
  handle: AttachHandle;
  /** Subscribers draining stdout/stderr (normally exactly one: the GET stream). */
  readonly subscribers: Set<(chunk: Buffer) => void>;
  /** Called when the child exits so the stream can close cleanly. */
  onExit?: () => void;
  idleTimer?: NodeJS.Timeout;
  exited: boolean;
}

const sessions = new Map<string, AttachSession>();

// A session with no GET stream draining it (browser tab closed without a clean
// DELETE) is reaped so the `docker attach` child can't linger forever.
const IDLE_MS = 30_000;

function armIdleReaper(s: AttachSession) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.subscribers.size === 0) destroy(s.id);
  }, IDLE_MS);
}

// Hard ceilings on live sessions. The idle reaper only fires at zero
// subscribers, so a client that holds its EventSource open forever is never
// reclaimed by it — without a cap each open() pins a backing (and its gRPC
// client) for good. Oldest-first eviction (the Map preserves insertion order);
// firing onExit first lets the evicted GET stream close instead of hanging.
const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_APP = 8;

function evict(s: AttachSession) {
  s.onExit?.();
  destroy(s.id);
}

function enforceSessionCaps(appId: string) {
  const forApp = [...sessions.values()].filter((s) => s.appId === appId);
  if (forApp.length >= MAX_SESSIONS_PER_APP) evict(forApp[0]);
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.values().next().value;
    if (oldest) evict(oldest);
  }
}

/**
 * Open a new attach session over a pre-built backing handle. The caller MUST
 * have already verified the container belongs to `appId`, chosen the tty
 * backing, and built the handle against the project's OWNING server (local
 * docker for localhost, the agent's bidi Attach for remote). `cleanup` runs once
 * when the backing exits/closes (e.g. `conn.close()` for a remote gRPC client) —
 * bound here so it can never leak. Returns the session id; the browser passes it
 * back on the GET (to stream) and POST (to send input).
 */
export function open(
  appId: string,
  containerName: string,
  handle: AttachHandle,
  cleanup?: () => void,
): AttachSession {
  enforceSessionCaps(appId);
  const id = `att_${randomBytes(12).toString("hex")}`;
  const session: AttachSession = {
    id,
    appId,
    containerName,
    handle,
    subscribers: new Set(),
    exited: false,
  };

  handle.onData((chunk) => {
    for (const sub of session.subscribers) sub(chunk);
  });

  handle.onExit(() => {
    if (session.exited) return;
    session.exited = true;
    cleanup?.();
    session.onExit?.();
    clearTimeout(session.idleTimer);
    sessions.delete(id);
  });

  sessions.set(id, session);
  armIdleReaper(session);
  return session;
}

/** Look up a session, scoped to its project so ids can't be used cross-project. */
export function get(id: string, appId: string): AttachSession | undefined {
  const s = sessions.get(id);
  return s && s.appId === appId ? s : undefined;
}

/** Subscribe to a session's output; returns an unsubscribe fn. */
export function subscribe(
  s: AttachSession,
  onChunk: (chunk: Buffer) => void,
): () => void {
  s.subscribers.add(onChunk);
  clearTimeout(s.idleTimer);
  return () => {
    s.subscribers.delete(onChunk);
    if (s.subscribers.size === 0) armIdleReaper(s);
  };
}

/** Tear down a session: kill the local attach client (never the container). */
export function destroy(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.idleTimer);
  sessions.delete(id);
  s.handle.close();
}
