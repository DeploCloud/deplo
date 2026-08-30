// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { randomBytes } from "node:crypto";
import { type AttachHandle } from "../infra/docker";

/**
 * In-process registry of live `docker attach` sessions.
 */

export interface AttachSession {
  id: string;
  /** App that authorised this session - POST/GET must match it. */
  appId: string;
  /**
   * Team the session was opened under. POST/DELETE re-check the caller's active
   * team against this so an id opened in one team can't be driven from another.
   */
  teamId: string;
  /**
   * The single user who opened this session and was authorised for it. POST/DELETE
   * honour ONLY this principal - possession of the id is not authority, so a
   * different (or since-demoted) user can't keep writing to PID 1 on its TTL.
   */
  userId: string;
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

// Hard ceilings on live sessions. The idle reaper only fires at zero subscribers,
// so a client that holds its EventSource open forever is never reclaimed by it -
// without a cap each open() pins a backing (and its gRPC client) for good.
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
 * Open a new attach session over a pre-built backing handle. `cleanup` runs once
 * when the backing exits/closes (e.g. `conn.close()` for a remote gRPC client) -
 * bound here so it can never leak.
 */
export function open(
  appId: string,
  teamId: string,
  userId: string,
  containerName: string,
  handle: AttachHandle,
  cleanup?: () => void,
): AttachSession {
  enforceSessionCaps(appId);
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

/**
 * Tear down every session of one app - what turning the app's console OFF does,
 * so an open terminal stops at the flip rather than at the next page load.
 */
export function destroyForApp(appId: string): void {
  for (const s of [...sessions.values()]) {
    if (s.appId !== appId) continue;
    s.onExit?.();
    destroy(s.id);
  }
}

/** Tear down a session: kill the local attach client (never the container). */
export function destroy(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.idleTimer);
  sessions.delete(id);
  s.handle.close();
}
