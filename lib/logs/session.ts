import "server-only";

import { randomBytes } from "node:crypto";
import { type AttachHandle } from "../infra/docker";

export interface LogsSession {
  id: string;
  appId: string;
  userId: string;
  containerName: string;
  handle: AttachHandle;
  readonly subscribers: Set<(chunk: Buffer) => void>;
  backlog: Buffer[] | null;
  onExit?: (error?: string) => void;
  idleTimer?: NodeJS.Timeout;
  exited: boolean;
}

const sessions = new Map<string, LogsSession>();

const IDLE_MS = 30_000;

function armIdleReaper(s: LogsSession) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.subscribers.size === 0) destroy(s.id);
  }, IDLE_MS);
}

const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_APP = 8;
const MAX_SESSIONS_PER_USER = 16;

function evict(s: LogsSession) {
  s.onExit?.();
  destroy(s.id);
}

function enforceSessionCaps(appId: string, userId: string) {
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

export function get(id: string, appId: string): LogsSession | undefined {
  const s = sessions.get(id);
  return s && s.appId === appId ? s : undefined;
}

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

export function destroy(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.idleTimer);
  sessions.delete(id);
  s.handle.close();
}

export function __allSessionIdsForTest(): string[] {
  return [...sessions.keys()];
}
