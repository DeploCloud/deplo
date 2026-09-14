import "server-only";

import { randomBytes } from "node:crypto";
import { type AttachHandle } from "../infra/docker";

export interface AttachSession {
  id: string;
  // App that authorised this session - POST/GET must match it.
  appId: string;
  // POST/DELETE re-check the caller's active team, so an id opened in one team can't be driven from another.
  teamId: string;
  // POST/DELETE honour ONLY this principal: possession of the id is not authority.
  userId: string;
  containerName: string;
  handle: AttachHandle;
  readonly subscribers: Set<(chunk: Buffer) => void>;
  // Set by the GET stream so it closes cleanly when the child exits.
  onExit?: () => void;
  idleTimer?: NodeJS.Timeout;
  exited: boolean;
}

const sessions = new Map<string, AttachSession>();

// A tab closed without a clean DELETE leaves no subscriber; reaping stops the `docker attach` child lingering forever.
const IDLE_MS = 30_000;

function armIdleReaper(s: AttachSession) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.subscribers.size === 0) destroy(s.id);
  }, IDLE_MS);
}

// The idle reaper never fires while an EventSource is held open, so without a cap each open() pins a backing (and its gRPC client) for good.
const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_APP = 8;
// One person cannot hold the whole instance ceiling.
const MAX_SESSIONS_PER_USER = 16;

function evict(s: AttachSession) {
  s.onExit?.();
  destroy(s.id);
}

function enforceSessionCaps(appId: string, userId: string) {
  // Only the caller's OWN sessions are ever evicted: a cap hit by other people's streams is a refusal, never a way to close their consoles.
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

// Open a session over a pre-built handle; `cleanup` runs once when the backing exits/closes, bound here so it can never leak.
export function open(
  appId: string,
  teamId: string,
  userId: string,
  containerName: string,
  handle: AttachHandle,
  cleanup?: () => void,
): AttachSession {
  enforceSessionCaps(appId, userId);
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

// Look up a session, scoped to its project so ids can't be used cross-project.
export function get(id: string, appId: string): AttachSession | undefined {
  const s = sessions.get(id);
  return s && s.appId === appId ? s : undefined;
}

// Subscribe to a session's output; returns an unsubscribe fn.
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

// Tear down every session of one app: turning the console OFF stops an open terminal at the flip, not at the next page load.
export function destroyForApp(appId: string): void {
  for (const s of [...sessions.values()]) {
    if (s.appId !== appId) continue;
    s.onExit?.();
    destroy(s.id);
  }
}

// Tear down a session: kill the local attach client, never the container.
export function destroy(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.idleTimer);
  sessions.delete(id);
  s.handle.close();
}
