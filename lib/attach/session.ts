import "server-only";

import { randomBytes } from "node:crypto";
import { type AttachHandle } from "../infra/docker";

export interface AttachSession {
  id: string;
  appId: string;
  teamId: string;
  userId: string;
  containerName: string;
  handle: AttachHandle;
  readonly subscribers: Set<(chunk: Buffer) => void>;
  onExit?: () => void;
  idleTimer?: NodeJS.Timeout;
  exited: boolean;
}

const sessions = new Map<string, AttachSession>();

const IDLE_MS = 30_000;

function armIdleReaper(s: AttachSession) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.subscribers.size === 0) destroy(s.id);
  }, IDLE_MS);
}

const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_APP = 8;
const MAX_SESSIONS_PER_USER = 16;

function evict(s: AttachSession) {
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
  teamId: string,
  userId: string,
  containerName: string,
  handle: AttachHandle,
  cleanup?: () => void,
): AttachSession {
  try {
    enforceSessionCaps(appId, userId);
  } catch (e) {
    // A refused session still owns the stream and the agent connection it was handed.
    handle.close();
    cleanup?.();
    throw e;
  }
  const id = `att_${randomBytes(12).toString("hex")}`;
  const session: AttachSession = {
    id,
    appId,
    teamId,
    userId,
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

export function get(id: string, appId: string): AttachSession | undefined {
  const s = sessions.get(id);
  return s && s.appId === appId ? s : undefined;
}

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

export function destroyForApp(appId: string): void {
  for (const s of [...sessions.values()]) {
    if (s.appId !== appId) continue;
    s.onExit?.();
    destroy(s.id);
  }
}

export function destroy(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.idleTimer);
  sessions.delete(id);
  s.handle.close();
}
