import "server-only";

import { randomBytes } from "node:crypto";
import { type AttachHandle } from "../infra/docker";

/**
 * In-process registry of live `docker logs -f` sessions. The session layer never
 * knows which backing produced the handle.
 */

export interface LogsSession {
  id: string;
  /** App that authorised this session - the GET must match it. */
  appId: string;
  /**
   * The principal the GET opened this session as. A session id is a capability
   * on its own - anyone holding one could close somebody else's live log stream,
   * so the DELETE re-checks it, the same way the attach session does.
   */
  userId: string;
  /** Real container name being streamed. */
  containerName: string;
  handle: AttachHandle;
  /** Subscribers draining output (normally exactly one: the GET stream). */
  readonly subscribers: Set<(chunk: Buffer) => void>;
  /**
   * Output emitted before the first subscriber attached. Captured here and flushed
   * on the first subscribe, then left null so live chunks pass straight through.
   */
  backlog: Buffer[] | null;
  /**
   * Called when the `docker logs` child exits so the stream can close cleanly.
   */
  onExit?: (error?: string) => void;
  idleTimer?: NodeJS.Timeout;
  exited: boolean;
}

const sessions = new Map<string, LogsSession>();

// A session with no GET stream draining it (browser tab closed without a clean
// DELETE) is reaped so the `docker logs -f` child can't linger forever.
const IDLE_MS = 30_000;

function armIdleReaper(s: LogsSession) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.subscribers.size === 0) destroy(s.id);
  }, IDLE_MS);
}

// Hard ceilings on live sessions. The idle reaper only fires at zero subscribers,
// so a client that holds its EventSource open forever is never reclaimed by it -
// without a cap each open() pins a backing (and its gRPC client) for good.
const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_APP = 8;

function evict(s: LogsSession) {
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
 * Open a new logs session over a pre-built backing handle.
 */
export function open(
  appId: string,
  userId: string,
  containerName: string,
  handle: AttachHandle,
  cleanup?: () => void,
): LogsSession {
  enforceSessionCaps(appId);
  const id = `log_${randomBytes(12).toString("hex")}`;
  const session: LogsSession = {
    id,
    appId,
    userId,
    containerName,
    handle,
    subscribers: new Set(),
    backlog: [],
    exited: false,
  };

  handle.onData((chunk) => {
    // Before anyone is listening, stash the chunk (the startup tail burst);
    // once a subscriber exists, fan out live. The backlog is drained, and set
    // to null - by the first subscribe().
    if (session.subscribers.size === 0 && session.backlog) {
      session.backlog.push(chunk);
      return;
    }
    for (const sub of session.subscribers) sub(chunk);
  });

  handle.onExit((error) => {
    if (session.exited) return;
    session.exited = true;
    cleanup?.();
    session.onExit?.(error);
    clearTimeout(session.idleTimer);
    sessions.delete(id);
  });

  sessions.set(id, session);
  armIdleReaper(session);
  return session;
}

/** Look up a session, scoped to its project so ids can't be used cross-project. */
export function get(id: string, appId: string): LogsSession | undefined {
  const s = sessions.get(id);
  return s && s.appId === appId ? s : undefined;
}

/** Subscribe to a session's output; returns an unsubscribe fn. */
export function subscribe(
  s: LogsSession,
  onChunk: (chunk: Buffer) => void,
): () => void {
  s.subscribers.add(onChunk);
  clearTimeout(s.idleTimer);
  // Flush the startup tail captured before this subscriber attached, then drop the
  // backlog so subsequent live chunks pass straight through.
  if (s.backlog) {
    const pending = s.backlog;
    s.backlog = null;
    for (const chunk of pending) onChunk(chunk);
  }
  return () => {
    s.subscribers.delete(onChunk);
    if (s.subscribers.size === 0) armIdleReaper(s);
  };
}

/** Tear down a session: kill the local `docker logs` client (never the container). */
export function destroy(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.idleTimer);
  sessions.delete(id);
  s.handle.close();
}
