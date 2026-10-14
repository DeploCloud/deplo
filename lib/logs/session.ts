import "server-only";

import { randomBytes } from "node:crypto";
import { type AttachHandle } from "../infra/docker";
import {
  accessSweep,
  makeRoom,
  type LiveSessionOwner,
} from "../live-session-guard";

export interface LogsSession extends LiveSessionOwner {
  id: string;
  containerName: string;
  handle: AttachHandle;
  readonly subscribers: Set<(chunk: Buffer) => void>;
  backlog: Buffer[] | null;
  backlogBytes: number;
  onExit?: (error?: string) => void;
  idleTimer?: NodeJS.Timeout;
  exited: boolean;
}

const sessions = new Map<string, LogsSession>();

const IDLE_MS = 30_000;
// What a session holds before its viewer subscribes; the oldest chunks go first.
export const MAX_BACKLOG_BYTES = 1024 * 1024;

function armIdleReaper(s: LogsSession) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.subscribers.size === 0) destroy(s.id);
  }, IDLE_MS);
}

function evict(s: LogsSession, error?: string) {
  s.onExit?.(error);
  destroy(s.id);
}

export const recheckAccess = accessSweep(sessions, (s) =>
  evict(s, "forbidden"),
);

export function open(
  owner: LiveSessionOwner,
  containerName: string,
  handle: AttachHandle,
  cleanup?: () => void,
): LogsSession {
  try {
    makeRoom(sessions, owner, (s) => evict(s));
  } catch (e) {
    // A refused session still owns the stream and the agent connection it was handed.
    handle.close();
    cleanup?.();
    throw e;
  }
  const id = `log_${randomBytes(12).toString("hex")}`;
  const session: LogsSession = {
    ...owner,
    id,
    containerName,
    handle,
    subscribers: new Set(),
    backlog: [],
    backlogBytes: 0,
    exited: false,
  };

  handle.onData((chunk) => {
    if (session.subscribers.size === 0 && session.backlog) {
      session.backlog.push(chunk);
      session.backlogBytes += chunk.length;
      while (session.backlogBytes > MAX_BACKLOG_BYTES && session.backlog.length)
        session.backlogBytes -= session.backlog.shift()!.length;
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
