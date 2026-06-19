import "server-only";

import { randomBytes } from "node:crypto";
import { followLogs, type AttachHandle } from "../infra/docker";

/**
 * In-process registry of live `docker logs -f` sessions.
 *
 * A logs viewer is output-only — there is no stdin direction to coordinate, so
 * unlike the attach session (lib/attach/session.ts) a session is just the GET
 * stream draining a `docker logs -f` child. The shared `AttachHandle` shape lets
 * the SSE route reuse the same subscribe/onExit plumbing; `write` is a no-op on
 * the logs backing.
 *
 * This map is module-level singleton state: it survives across requests within
 * one server process, matching Deplo's single-process-against-one-socket model
 * (see lib/attach/session.ts for the same reasoning).
 */

export interface LogsSession {
  id: string;
  /** Project that authorised this session — the GET must match it. */
  projectId: string;
  /** Real container name being streamed. */
  containerName: string;
  handle: AttachHandle;
  /** Subscribers draining output (normally exactly one: the GET stream). */
  readonly subscribers: Set<(chunk: Buffer) => void>;
  /**
   * Output emitted before the first subscriber attached. `docker logs -f --tail`
   * dumps the recent-history burst the instant it starts — which is before the
   * route has wired up its GET stream — so without a backlog that whole tail
   * (the "latest logs" the viewer exists to show) fans out to zero subscribers
   * and is lost. Captured here and flushed on the first subscribe, then left
   * null so live chunks pass straight through.
   */
  backlog: Buffer[] | null;
  /** Called when the `docker logs` child exits so the stream can close cleanly. */
  onExit?: () => void;
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

/**
 * Open a new logs session against a container. The caller MUST have already
 * verified the container belongs to `projectId`. Returns the session id; the
 * browser passes it back on the DELETE to detach.
 */
export function open(projectId: string, containerName: string, tail = 500): LogsSession {
  const handle = followLogs(containerName, tail);
  const id = `log_${randomBytes(12).toString("hex")}`;
  const session: LogsSession = {
    id,
    projectId,
    containerName,
    handle,
    subscribers: new Set(),
    backlog: [],
    exited: false,
  };

  handle.onData((chunk) => {
    // Before anyone is listening, stash the chunk (the startup tail burst);
    // once a subscriber exists, fan out live. The backlog is drained — and set
    // to null — by the first subscribe().
    if (session.subscribers.size === 0 && session.backlog) {
      session.backlog.push(chunk);
      return;
    }
    for (const sub of session.subscribers) sub(chunk);
  });

  handle.onExit(() => {
    if (session.exited) return;
    session.exited = true;
    session.onExit?.();
    clearTimeout(session.idleTimer);
    sessions.delete(id);
  });

  sessions.set(id, session);
  armIdleReaper(session);
  return session;
}

/** Look up a session, scoped to its project so ids can't be used cross-project. */
export function get(id: string, projectId: string): LogsSession | undefined {
  const s = sessions.get(id);
  return s && s.projectId === projectId ? s : undefined;
}

/** Subscribe to a session's output; returns an unsubscribe fn. */
export function subscribe(
  s: LogsSession,
  onChunk: (chunk: Buffer) => void,
): () => void {
  s.subscribers.add(onChunk);
  clearTimeout(s.idleTimer);
  // Flush the startup tail captured before this subscriber attached, then drop
  // the backlog so subsequent live chunks pass straight through. Only the first
  // subscriber drains it (it's nulled here); a late second subscriber just
  // joins the live fan-out.
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
