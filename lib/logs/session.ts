import "server-only";

import { randomBytes } from "node:crypto";
import { type AttachHandle } from "../infra/docker";

export interface LogsSession {
  id: string;
  // App that authorised this session - the GET must match it.
  appId: string;
  // A session id is a capability on its own, so the DELETE re-checks the principal.
  userId: string;
  containerName: string;
  handle: AttachHandle;
  // Subscribers draining output, normally exactly one: the GET stream.
  readonly subscribers: Set<(chunk: Buffer) => void>;
  // Null once the first subscribe() flushed it, so live chunks pass straight through.
  backlog: Buffer[] | null;
  onExit?: (error?: string) => void;
  idleTimer?: NodeJS.Timeout;
  exited: boolean;
}

const sessions = new Map<string, LogsSession>();

// A tab closed without a clean DELETE leaves no subscriber, and the `docker logs -f` child would linger forever.
const IDLE_MS = 30_000;

function armIdleReaper(s: LogsSession) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.subscribers.size === 0) destroy(s.id);
  }, IDLE_MS);
}

// The idle reaper only fires at zero subscribers, so an EventSource held open forever pins a backing (and its gRPC client) for good.
const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_APP = 8;
// One person cannot hold the whole instance ceiling.
const MAX_SESSIONS_PER_USER = 16;

function evict(s: LogsSession) {
  s.onExit?.();
  destroy(s.id);
}

function enforceSessionCaps(appId: string, userId: string) {
  // Only the caller's OWN sessions are evicted: a cap reached by other people's streams is a refusal.
  const mine = [...sessions.values()].filter((s) => s.userId === userId);
  const forApp = mine.filter((s) => s.appId === appId);
  if (forApp.length >= MAX_SESSIONS_PER_APP) evict(forApp[0]);
  else if (mine.length >= MAX_SESSIONS_PER_USER) evict(mine[0]);
  if (sessions.size >= MAX_SESSIONS) {
    if (mine[0]) evict(mine[0]);
    else
      throw new Error(
        "Too many live sessions on this Deplo right now. Try again in a moment.",
      );
  }
}

// Open a new logs session over a pre-built backing handle.
export function open(
  appId: string,
  userId: string,
  containerName: string,
  handle: AttachHandle,
  cleanup?: () => void,
): LogsSession {
  enforceSessionCaps(appId, userId);
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

// Look up a session, scoped to its project so ids can't be used cross-project.
export function get(id: string, appId: string): LogsSession | undefined {
  const s = sessions.get(id);
  return s && s.appId === appId ? s : undefined;
}

// Subscribe to a session's output; returns an unsubscribe fn.
export function subscribe(
  s: LogsSession,
  onChunk: (chunk: Buffer) => void,
): () => void {
  s.subscribers.add(onChunk);
  clearTimeout(s.idleTimer);
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

// Tear down a session: kill the local `docker logs` client (never the container).
export function destroy(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.idleTimer);
  sessions.delete(id);
  s.handle.close();
}

// Every live session id - for the cap test only.
export function __allSessionIdsForTest(): string[] {
  return [...sessions.keys()];
}
