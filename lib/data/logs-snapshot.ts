import "server-only";

import { StringDecoder } from "node:string_decoder";
import { connectAgent } from "../infra/agent-client/connect";
import { resolveLogsTarget } from "./console";
import { resolveDatabaseLogsTarget } from "./database-console";

const MAX_LINES = 500;
const MAX_BYTES = 64 * 1024;
const QUIET_MS = 400;
const HARD_MS = 5_000;

export interface LogsSnapshot {
  container: string;
  text: string;
  truncated: boolean;
}

function drain(
  handle: {
    onData(cb: (chunk: Buffer) => void): () => void;
    onExit(cb: (error?: string) => void): void;
    close(): void;
  },
  cleanup: () => void,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve) => {
    // A StringDecoder, not chunk.toString(): a multi-byte glyph straddling two frames would decode as replacement characters.
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
        out = out.slice(-MAX_BYTES);
        truncated = true;
      }
      bump();
    });
    // A container with nothing to say never emits, so the quiet timer is armed before the first chunk.
    bump();
    handle.onExit(finish);
  });
}

// appLogsSnapshot reads the tail of an app container's logs, gated by view_logs in resolveLogsTarget.
export async function appLogsSnapshot(
  appId: string,
  opts: { container?: string; lines?: number } = {},
): Promise<LogsSnapshot> {
  const resolved = await resolveLogsTarget(appId, opts.container);
  if (!resolved.ok) throw new Error(logsFailure(resolved.reason));

  if (!resolved.server)
    throw new Error("This app has no server assigned yet, so it has no logs.");

  const tail = clampLines(opts.lines);
  const conn = await connectAgent(resolved.server.id);
  const handle = conn.followLogs(appId, resolved.instance.name, tail);
  const { text, truncated } = await drain(handle, () => conn.close());
  return { container: resolved.instance.name, text, truncated };
}

// databaseLogsSnapshot reads the tail of a database container's logs. Same gate, same shape.
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

// The resolver answers with a reason rather than throwing: its other caller is an SSE route mapping reasons to status codes.
function logsFailure(reason: string): string {
  switch (reason) {
    case "not-found":
      return "No such app in this team.";
    case "forbidden":
      return "This token can't read logs (it needs the view_logs capability).";
    case "unreachable":
      return "The server running this app is unreachable, so its logs can't be read right now.";
    case "no-instance":
      return "This app has no container yet - deploy it first.";
    default:
      return `Logs are unavailable (${reason}).`;
  }
}
