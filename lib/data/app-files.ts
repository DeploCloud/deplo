// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// https://deplo.build/docs/guides/data/persistent-storage

import { status as GrpcStatus } from "@grpc/grpc-js";
import { getCurrentUser } from "../auth";
import { recordActivity } from "./activity";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { appMounts as appMountsTable } from "../db/schema/control-plane";
import { loadTeamApp } from "./app-graph-load";
import { requireAppCapability } from "./node-access";
import {
  connectAgent,
  AgentUnreachableError,
  type AgentConnection,
} from "../infra/agent-client";

/**
 * Read and write the files a **File** volume points at - the on-disk
 * `<stacks>/files/<slug>` tree that backs the `./` app-files convention
 * (see `lib/deploy/compose-stack.ts`).
 */

/** Reject writes whose body exceeds this - the editor is for config, not blobs. */
const MAX_WRITE_BYTES = 1024 * 1024; // 1 MiB

/**
 * Normalise a relative path to a clean POSIX form, rejecting absolute paths and
 * any `..` traversal before it can reach the filesystem. Backslashes are folded to
 * `/` so a Windows-style `..\` can't sneak past the segment check.
 */
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
  return rel;
}

/** Confirm the project is in the caller's team; throws if not. Resolves the
 * owning server id so each op can route to that host's agent. */
async function requireAppInTeam(
  appId: string,
): Promise<{ slug: string; teamId: string; serverId: string }> {
  // A File volume's body is part of the app's configuration, so it rides the
  // same capability the rest of Settings → Storage does.
  const { teamId } = await requireAppCapability(appId, "configure_apps");
  const project = await loadTeamApp(appId, teamId);
  if (!project) {
    throw new Error("App not found");
  }
  return { slug: project.slug, teamId, serverId: project.serverId };
}

/** Open a connection to a project's owning agent (all file ops route here). */
function agentFor(serverId: string): Promise<AgentConnection> {
  return connectAgent(serverId);
}

/**
 * Write (create or overwrite) a text file at `path`. Parent dirs are created as
 * needed. The body is capped so the editor stays a config editor, not an upload
 * channel. Answers the path that was written.
 */
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
    // The stored copy moves with the file, or the next deploy undoes this.
    await syncAppMount(appId, path, content);
    await note(appId, `Edited file ${entry.path}`);
    return entry.path;
  } finally {
    conn.close();
  }
}

/** What the Storage editor found at a File entry's path in this app's Files. */
export type StorageFileState =
  "text" | "new" | "folder" | "binary" | "too-large";

/**
 * What a FAILED agent read of a File entry's path means, or null when the failure
 * is real and must be rethrown.
 */
export function storageFileStateForError(e: unknown): StorageFileState | null {
  const code = (e as { code?: number } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (code === GrpcStatus.NOT_FOUND) return "new";
  if (code === GrpcStatus.INVALID_ARGUMENT && /not a file/i.test(message)) {
    return "folder";
  }
  return null;
}

/**
 * The user-facing failure for a read deplo could NOT classify - the editor puts
 * this next to a "Try again" button, so it has to say what happened.
 */
export function storageFileReadError(e: unknown): Error {
  return new Error(
    e instanceof AgentUnreachableError
      ? "The server that runs this app didn't answer, so deplo couldn't read this file. It may be offline."
      : "deplo couldn't read this file from the server that runs this app.",
    { cause: e },
  );
}

export interface StorageFile {
  /** The normalised path that was read. */
  path: string;
  state: StorageFileState;
  /** The body. Always "" for anything but "text". */
  text: string;
}

/**
 * Read the file a **File** storage entry points at (Settings → Storage), where a
 * path that isn't there yet is a normal answer, `state: "new"`, rather than an
 * error.
 */
export async function readAppStorageFile(
  appId: string,
  path: string,
): Promise<StorageFile> {
  const { slug, serverId } = await requireAppInTeam(appId);
  const rel = normalizeRel(path);
  if (!rel) throw new Error("A path in this app's Files is required");
  // The dial is INSIDE the try: a server with no provisioned agent (or with its
  // trust revoked) fails right here, and that has to reach the editor as the
  // same plain "the server didn't answer" as a dead connection does.
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

/**
 * Keep the app's stored CONFIG FILES in step with what just happened on disk.
 */
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

/** Record a project-scoped activity line for a files change. */
async function note(appId: string, message: string): Promise<void> {
  const user = await getCurrentUser();
  await recordActivity("app", message, user?.email ?? "system", appId);
}
