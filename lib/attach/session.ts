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
 * The backing handle is BUILT BY THE CALLER and passed in (PLAN Part C): for a
 * localhost project it is `attachContainer*` over the local docker socket; for a
 * remote project it is the owning agent's bidi `Attach` stream adapted to the
 * same AttachHandle shape (the pty lives Go-side now). The session layer is
 * identical for both. An optional `cleanup` (closing the agent's gRPC client) is
 * bound atomically into the exit path here.
 *
 * This map is module-level singleton state: it survives across requests within
 * one server process. It is NOT shared across a multi-process/clustered
 * deployment — Deplo runs as a single Node server against one Docker socket, so
 * a request for a session always lands on the process that owns it.
 */

export interface AttachSession {
  id: string;
  /** Project that authorised this session — POST/GET must match it. */
  projectId: string;
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

/**
 * Open a new attach session over a pre-built backing handle. The caller MUST
 * have already verified the container belongs to `projectId`, chosen the tty
 * backing, and built the handle against the project's OWNING server (local
 * docker for localhost, the agent's bidi Attach for remote). `cleanup` runs once
 * when the backing exits/closes (e.g. `conn.close()` for a remote gRPC client) —
 * bound here so it can never leak. Returns the session id; the browser passes it
 * back on the GET (to stream) and POST (to send input).
 */
export function open(
  projectId: string,
  containerName: string,
  handle: AttachHandle,
  cleanup?: () => void,
): AttachSession {
  const id = `att_${randomBytes(12).toString("hex")}`;
  const session: AttachSession = {
    id,
    projectId,
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
export function get(id: string, projectId: string): AttachSession | undefined {
  const s = sessions.get(id);
  return s && s.projectId === projectId ? s : undefined;
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
