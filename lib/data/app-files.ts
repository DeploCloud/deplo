import "server-only";

// https://deplo.build/docs/guides/observability/console-and-files

import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { status as GrpcStatus } from "@grpc/grpc-js";
import { getActiveTeamId } from "../membership";
import type { Capability } from "../types";
import { getCurrentUser } from "../auth";
import { recordActivity } from "./activity";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { appMounts as appMountsTable } from "../db/schema/control-plane";
import { loadTeamApp } from "./app-graph-load";
import { hasAppCapability, requireAppCapability } from "./node-access";
import {
  connectAgent,
  AgentUnreachableError,
  type AgentConnection,
} from "../infra/agent-client";

/**
 * Browse and edit a single-container project's files directory — the on-disk
 * `<stacks>/files/<slug>` tree that backs the `./` app-files volume convention
 * (see `lib/deploy/compose-stack.ts`).
 */

/** Reject writes whose body exceeds this — the editor is for config, not blobs. */
const MAX_WRITE_BYTES = 1024 * 1024; // 1 MiB

export interface FileEntry {
  /** Path relative to the project files root, POSIX-separated, no leading slash. */
  path: string;
  /** Final path segment (the display name). */
  name: string;
  /** "dir" or "file" — symlinks are resolved; anything else is skipped. */
  kind: "dir" | "file";
  /** Byte size (0 for directories). */
  size: number;
  /** Last-modified ISO timestamp. */
  modifiedAt: string;
}

export interface FileContent {
  path: string;
  /** UTF-8 text body. Null when the file is binary or too large to view. */
  text: string | null;
  size: number;
  /** Why `text` is null: "binary" or "too-large"; null when text is present. */
  reason: "binary" | "too-large" | null;
}

/**
 * Resolve `relPath` (user-supplied) to an absolute host path that is PROVABLY
 * inside `root`, with symlinks resolved. Both `root` and the resolved candidate
 * must already exist.
 */
export async function resolveWithinRoot(
  root: string,
  relPath: string,
): Promise<string> {
  const rel = normalizeRel(relPath);
  const candidate = rel ? join(root, rel) : root;
  const realRoot = await realpath(root); // root always exists by the time we read
  const realCandidate = await realpath(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new Error("Path escapes the project files directory");
  }
  return realCandidate;
}

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
  // Reading a file and changing one are separate permissions, so each op names
  // which it needs. Defaults to the read side — the weaker of the two.
  cap: Capability = "read_app_files",
): Promise<{ slug: string; teamId: string; serverId: string }> {
  const { teamId } = await requireAppCapability(appId, cap);
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

/** Narrow the agent's structural FileEntry (kind: string) to the local union. */
function toEntry(e: {
  path: string;
  name: string;
  kind: string;
  size: number;
  modifiedAt: string;
}): FileEntry {
  return {
    path: e.path,
    name: e.name,
    kind: e.kind === "dir" ? "dir" : "file",
    size: e.size,
    modifiedAt: e.modifiedAt,
  };
}

/**
 * Whether a project's on-disk files directory exists AND the caller may manage it
 * — the single gate that drives the Files tab's visibility.
 */
export async function appFilesExist(appId: string): Promise<boolean> {
  // Per-app, not team-wide: `read_app_files` held somewhere else in the team is
  // not permission to read THIS app's files, and the tab must match what the
  // read itself (requireAppCapability) will allow.
  if (!(await hasAppCapability(appId, "read_app_files"))) return false;
  const teamId = await getActiveTeamId();
  if (!teamId) return false;
  const project = await loadTeamApp(appId, teamId);
  if (!project) return false;
  // Ask the owning agent — the files dir is on its host's disk (PLAN Part C, D9),
  // the host running Deplo included. An unreachable agent yields false so the tab
  // is hidden (never a 500 during the project layout render).
  let conn: AgentConnection | undefined;
  try {
    conn = await agentFor(project.serverId);
    return await conn.filesExist(project.slug);
  } catch {
    return false;
  } finally {
    conn?.close();
  }
}

/**
 * List the immediate children of `path` (the root when omitted), directories
 * first then files, each alphabetical. Symlinks and special files are skipped
 * — only real dirs/files inside the sandbox are returned.
 */
export async function listAppFiles(
  appId: string,
  path = "",
): Promise<FileEntry[]> {
  const { slug, serverId } = await requireAppInTeam(appId);
  if (path) normalizeRel(path); // fast-fail guard (agent re-checks)
  const conn = await agentFor(serverId);
  try {
    return (await conn.listFiles(slug, path)).map(toEntry);
  } finally {
    conn.close();
  }
}

/** Read a file's text body, refusing binary or oversized files. */
export async function readAppFile(
  appId: string,
  path: string,
): Promise<FileContent> {
  const { slug, serverId } = await requireAppInTeam(appId);
  normalizeRel(path);
  const conn = await agentFor(serverId);
  try {
    const r = await conn.readFile(slug, path);
    return { path: r.path, text: r.text, size: r.size, reason: r.reason };
  } finally {
    conn.close();
  }
}

/**
 * Write (create or overwrite) a text file at `path`. Parent dirs are created as
 * needed. The body is capped so the editor stays a config editor, not an upload
 * channel. Returns the entry's fresh metadata.
 */
export async function writeAppFile(
  appId: string,
  path: string,
  content: string,
): Promise<FileEntry> {
  const { slug, serverId } = await requireAppInTeam(appId, "write_app_files");
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("File is too large to save (1 MiB max)");
  }
  normalizeRel(path);
  const conn = await agentFor(serverId);
  try {
    const entry = toEntry(await conn.writeFile(slug, path, content));
    // The stored copy moves with the file, or the next deploy undoes this.
    await syncAppMount(appId, path, { content });
    await note(appId, `Edited file ${entry.path}`);
    return entry;
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
 * The user-facing failure for a read deplo could NOT classify — the editor puts
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
 * path that isn't there yet is a normal answer — `state: "new"` — rather than an
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
 * Upload a file from a base64 body — the path the UI uses for binary files the
 * text editor can't represent. Same sandboxing and size cap as a text write.
 * Returns the entry's fresh metadata.
 */
export async function uploadAppFile(
  appId: string,
  path: string,
  base64: string,
): Promise<FileEntry> {
  const { slug, serverId } = await requireAppInTeam(appId, "write_app_files");
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    throw new Error("Invalid file data");
  }
  if (buf.byteLength > MAX_WRITE_BYTES) {
    throw new Error("File is too large to upload (1 MiB max)");
  }
  normalizeRel(path);
  const conn = await agentFor(serverId);
  try {
    const entry = toEntry(await conn.uploadFile(slug, path, buf));
    await note(appId, `Uploaded file ${entry.path}`);
    return entry;
  } finally {
    conn.close();
  }
}

/** Create an empty directory at `path` (recursive). Returns its entry. */
export async function createAppDir(
  appId: string,
  path: string,
): Promise<FileEntry> {
  const { slug, serverId } = await requireAppInTeam(appId, "write_app_files");
  normalizeRel(path);
  const conn = await agentFor(serverId);
  try {
    const entry = toEntry(await conn.createDir(slug, path));
    await note(appId, `Created folder ${entry.path}`);
    return entry;
  } finally {
    conn.close();
  }
}

/**
 * Delete a file or directory (recursively) at `path`. The root itself can't be
 * deleted — only entries strictly inside it.
 */
export async function deleteAppFile(
  appId: string,
  path: string,
): Promise<boolean> {
  const { slug, serverId } = await requireAppInTeam(appId, "write_app_files");
  normalizeRel(path);
  const conn = await agentFor(serverId);
  try {
    const ok = await conn.deleteFile(slug, path);
    if (ok) await syncAppMount(appId, path, { deleted: true });
    await note(appId, `Deleted ${normalizeRel(path)}`);
    return ok;
  } finally {
    conn.close();
  }
}

/** Rename / move an entry within the sandbox. Both ends are contained-checked. */
export async function renameAppFile(
  appId: string,
  path: string,
  newPath: string,
): Promise<FileEntry> {
  const { slug, serverId } = await requireAppInTeam(appId, "write_app_files");
  normalizeRel(path);
  normalizeRel(newPath);
  const conn = await agentFor(serverId);
  try {
    const entry = toEntry(await conn.renameFile(slug, path, newPath));
    await syncAppMount(appId, path, { renamedTo: entry.path });
    await note(appId, `Moved ${normalizeRel(path)} → ${entry.path}`);
    return entry;
  } finally {
    conn.close();
  }
}

/**
 * Keep the app's stored CONFIG FILES in step with what just happened on disk.
 */
async function syncAppMount(
  appId: string,
  path: string,
  change: { content: string } | { deleted: true } | { renamedTo: string },
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
  if ("deleted" in change) {
    await db
      .delete(appMountsTable)
      .where(
        and(
          eq(appMountsTable.appId, appId),
          eq(appMountsTable.filePath, filePath),
        ),
      );
    return;
  }
  const patch =
    "content" in change
      ? { content: change.content }
      : { filePath: normalizeRel(change.renamedTo) };
  await db
    .update(appMountsTable)
    .set(patch)
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
