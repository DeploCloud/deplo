import "server-only";

import { StringDecoder } from "node:string_decoder";
import { connectAgent } from "../infra/agent-client";
import { resolveLogsTarget } from "./console";
import { resolveDatabaseLogsTarget } from "./database-console";

/**
 * A one-shot read of a container's recent output.
 */

const MAX_LINES = 500;
const MAX_BYTES = 64 * 1024;
/** No new bytes for this long ⇒ the tail burst is over. */
const QUIET_MS = 400;
/** Absolute ceiling, so a chatty container can never hold the call open. */
const HARD_MS = 5_000;

export interface LogsSnapshot {
  /** The container actually read (the app's own, unless one was named). */
  container: string;
  text: string;
  /** True when a ceiling cut the output short, so the caller can say so. */
  truncated: boolean;
}

/**
 * Drain a freshly-opened logs handle until it goes quiet, then close it.
 *
 * Split out from the two callers below because the only difference between an
 * app's logs and a database's is which resolver authorised the container.
 */
function drain(
  handle: {
    onData(cb: (chunk: Buffer) => void): () => void;
    onExit(cb: (error?: string) => void): void;
    close(): void;
  },
  cleanup: () => void,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve) => {
    // A StringDecoder, not chunk.toString(): the agent's frames split wherever
    // the network split them, and a multi-byte glyph straddling two chunks would
    // otherwise decode as a pair of replacement characters.
    const decoder = new StringDecoder("utf8");
    let out = "";
    let truncated = false;
    let done = false;
    let quiet: NodeJS.Timeout | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(quiet);
      clearTimeout(hard);
      try {
        handle.close();
      } catch {
        /* already closed */
      }
      cleanup();
      resolve({ text: out, truncated });
    };

    const hard = setTimeout(finish, HARD_MS);
    const bump = () => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, QUIET_MS);
    };

    handle.onData((chunk) => {
      if (done) return;
      out += decoder.write(chunk);
      if (out.length >= MAX_BYTES) {
        // Keep the END, not the beginning: the last lines are the ones that
        // explain why a container is unhappy.
        out = out.slice(-MAX_BYTES);
        truncated = true;
      }
      bump();
    });
    // A container with nothing to say never emits, so the quiet timer has to be
    // armed before the first chunk or the call would sit until HARD_MS.
    bump();
    handle.onExit(finish);
  });
}

/** Read the tail of an app container's logs. Gated by `view_logs` inside {@link resolveLogsTarget}. */
export async function appLogsSnapshot(
  appId: string,
  opts: { container?: string; lines?: number } = {},
): Promise<LogsSnapshot> {
  const resolved = await resolveLogsTarget(appId, opts.container);
  if (!resolved.ok) throw new Error(logsFailure(resolved.reason));

  // The SSE route asserts this non-null; a tool handler answers the model in a
  // sentence instead of throwing a TypeError at it.
  if (!resolved.server)
    throw new Error("This app has no server assigned yet, so it has no logs.");

  const tail = clampLines(opts.lines);
  const conn = await connectAgent(resolved.server.id);
  const handle = conn.followLogs(appId, resolved.instance.name, tail);
  const { text, truncated } = await drain(handle, () => conn.close());
  return { container: resolved.instance.name, text, truncated };
}

/** Read the tail of a database container's logs. Same gate, same shape. */
export async function databaseLogsSnapshot(
  databaseId: string,
  opts: { container?: string; lines?: number } = {},
): Promise<LogsSnapshot> {
  const resolved = await resolveDatabaseLogsTarget(databaseId, opts.container);
  if (!resolved.ok) throw new Error(logsFailure(resolved.reason));

  const tail = clampLines(opts.lines);
  const conn = await connectAgent(resolved.serverId);
  const handle = conn.followLogs(databaseId, resolved.instance.name, tail);
  const { text, truncated } = await drain(handle, () => conn.close());
  return { container: resolved.instance.name, text, truncated };
}

function clampLines(lines: number | undefined): number {
  if (!Number.isFinite(lines)) return 200;
  return Math.min(Math.max(Math.trunc(lines as number), 1), MAX_LINES);
}

/**
 * The resolver answers with a reason rather than throwing, because its other
 * caller is an SSE route mapping reasons to status codes.
 */
function logsFailure(reason: string): string {
  switch (reason) {
    case "not-found":
      return "No such app in this team.";
    case "forbidden":
      return "This token can't read logs (it needs the view_logs capability).";
    case "unreachable":
      return "The server running this app is unreachable, so its logs can't be read right now.";
    case "no-instance":
      return "This app has no container yet — deploy it first.";
    default:
      return `Logs are unavailable (${reason}).`;
  }
}
