import "server-only";

import { status as GrpcStatus } from "@grpc/grpc-js";
import { getCurrentUser } from "../auth/current-user";
import { recordActivity } from "./activity";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { appMounts as appMountsTable } from "../db/schema/control-plane/apps";
import { loadTeamApp } from "./app-graph-load";
import { requireAppCapability } from "./node-access";
import { connectAgent } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { AgentUnreachableError } from "../infra/agent-client/errors";

const MAX_WRITE_BYTES = 1024 * 1024;

export function normalizeRel(relPath: string): string {
  const rel = (relPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/");
  if (rel === "" || rel === ".") return "";
  if (rel.split("/").some((seg) => seg === "..")) {
    throw new Error("Path traversal is not allowed");
  }
  const clean = rel
    .split("/")
    .filter((seg) => seg !== "." && seg !== "")
    .join("/");
  if (clean === "") return "";
  if (clean === ".env")
    throw new Error(
      "The .env file is written by Deplo from the app's variables - edit those in Settings → Environment.",
    );
  return clean;
}

async function requireAppInTeam(
  appId: string,
): Promise<{ slug: string; teamId: string; serverId: string }> {
  const { teamId } = await requireAppCapability(appId, "configure_apps");
  const project = await loadTeamApp(appId, teamId);
  if (!project) {
    throw new Error("App not found");
  }
  return { slug: project.slug, teamId, serverId: project.serverId };
}

function agentFor(serverId: string): Promise<AgentConnection> {
  return connectAgent(serverId);
}

export async function writeAppFile(
  appId: string,
  path: string,
  content: string,
): Promise<string> {
  const { slug, serverId } = await requireAppInTeam(appId);
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("File is too large to save (1 MiB max)");
  }
  normalizeRel(path);
  const conn = await agentFor(serverId);
  try {
    const entry = await conn.writeFile(slug, path, content);
    await syncAppMount(appId, path, content);
    await note(appId, `Edited file ${entry.path}`);
    return entry.path;
  } finally {
    conn.close();
  }
}

export type StorageFileState =
  "text" | "new" | "folder" | "binary" | "too-large";

export function storageFileStateForError(e: unknown): StorageFileState | null {
  const code = (e as { code?: number } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (code === GrpcStatus.NOT_FOUND) return "new";
  if (code === GrpcStatus.INVALID_ARGUMENT && /not a file/i.test(message)) {
    return "folder";
  }
  return null;
}

export function storageFileReadError(e: unknown): Error {
  return new Error(
    e instanceof AgentUnreachableError
      ? "The server that runs this app didn't answer, so Deplo couldn't read this file. It may be offline."
      : "Deplo couldn't read this file from the server that runs this app.",
    { cause: e },
  );
}

export interface StorageFile {
  path: string;
  state: StorageFileState;
  text: string;
}

export async function readAppStorageFile(
  appId: string,
  path: string,
): Promise<StorageFile> {
  const { slug, serverId } = await requireAppInTeam(appId);
  const rel = normalizeRel(path);
  if (!rel) throw new Error("A path in this app's Files is required");
  let conn: AgentConnection | undefined;
  try {
    conn = await agentFor(serverId);
    const r = await conn.readFile(slug, rel);
    if (r.reason) return { path: rel, state: r.reason, text: "" };
    return { path: rel, state: "text", text: r.text ?? "" };
  } catch (e) {
    const state = storageFileStateForError(e);
    if (!state) throw storageFileReadError(e);
    return { path: rel, state, text: "" };
  } finally {
    conn?.close();
  }
}

async function syncAppMount(
  appId: string,
  path: string,
  content: string,
): Promise<void> {
  const filePath = normalizeRel(path);
  if (!filePath) return;
  const db = getDb();
  const rows = await db
    .select({ position: appMountsTable.position })
    .from(appMountsTable)
    .where(
      and(
        eq(appMountsTable.appId, appId),
        eq(appMountsTable.filePath, filePath),
      ),
    );
  if (rows.length === 0) return;
  await db
    .update(appMountsTable)
    .set({ content })
    .where(
      and(
        eq(appMountsTable.appId, appId),
        eq(appMountsTable.filePath, filePath),
      ),
    );
}

async function note(appId: string, message: string): Promise<void> {
  const user = await getCurrentUser();
  await recordActivity("app", message, user?.name ?? "system", appId);
}
