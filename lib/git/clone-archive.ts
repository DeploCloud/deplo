import "server-only";

import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { tarEntries } from "../infra/tar-stream";
import { assertSafeOutboundUrl } from "../outbound-url";
import { cloneHostLabel, type CloneSource } from "./clone-source";

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 150 * 1024 * 1024;
export const MAX_SOURCE_FILES = 5000;
const META_TIMEOUT_MS = 10_000;
const ARCHIVE_TIMEOUT_MS = 90_000;

export interface SourceFile {
  path: string;
  bytes: Buffer;
  executable: boolean;
}

export interface SourceInfo {
  ref: string;
  description: string;
}

function encoded(fullName: string): string {
  return encodeURIComponent(fullName);
}

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: T | null }> {
  await assertSafeOutboundUrl(url, "The repository address");
  const res = await fetch(url, {
    headers: { "User-Agent": "deplo", Accept: "application/json", ...headers },
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(META_TIMEOUT_MS),
  }).catch(() => {
    throw new Error(`Deplo couldn't reach ${new URL(url).host}.`);
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, body: null };
  }
  return { status: res.status, body: (await res.json()) as T };
}

// The branch to copy, and a refusal for a repository that is not public.
export async function resolveSource(
  source: CloneSource,
  opts: { githubToken?: string | null } = {},
): Promise<SourceInfo> {
  const label = cloneHostLabel(source.host);
  const missing = new Error(
    `${source.fullName} isn't a public ${label} repository, or it doesn't exist.`,
  );
  if (source.host === "github") {
    const { status, body } = await getJson<{
      private?: boolean;
      default_branch?: string;
      description?: string | null;
    }>(`https://api.github.com/repos/${source.fullName}`, {
      Accept: "application/vnd.github+json",
      ...(opts.githubToken
        ? { Authorization: `Bearer ${opts.githubToken}` }
        : {}),
    });
    if (status === 403 || status === 429)
      throw new Error(
        "GitHub is limiting how often Deplo can ask right now. Try again in a few minutes.",
      );
    if (!body || body.private) throw missing;
    return {
      ref: source.ref ?? body.default_branch ?? "main",
      description: body.description ?? "",
    };
  }
  const { body } = await getJson<{
    visibility?: string;
    default_branch?: string | null;
    description?: string | null;
  }>(`https://gitlab.com/api/v4/projects/${encoded(source.fullName)}`, {});
  if (!body || (body.visibility && body.visibility !== "public")) throw missing;
  return {
    ref: source.ref ?? body.default_branch ?? "main",
    description: body.description ?? "",
  };
}

export function archiveUrl(source: CloneSource, ref: string): string {
  return source.host === "github"
    ? `https://codeload.github.com/${source.fullName}/tar.gz/${encodeURIComponent(ref)}`
    : `https://gitlab.com/api/v4/projects/${encoded(source.fullName)}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}`;
}

async function* capped(
  body: AsyncIterable<Uint8Array>,
  max: number,
  tooLarge: () => Error,
): AsyncGenerator<Uint8Array> {
  let seen = 0;
  for await (const chunk of body) {
    seen += chunk.length;
    if (seen > max) throw tooLarge();
    yield chunk;
  }
}

async function* gunzip(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const source = Readable.from(chunks);
  const inflated = source.pipe(createGunzip());
  source.on("error", (e) => inflated.destroy(e));
  try {
    for await (const chunk of inflated) yield chunk as Uint8Array;
  } finally {
    inflated.destroy();
    source.destroy();
  }
}

// Archives wrap everything in one top folder (<repo>-<sha>/); the copy starts below it.
export function stripTopFolder(name: string): string | null {
  const slash = name.indexOf("/");
  if (slash === -1) return null;
  const path = name.slice(slash + 1).replace(/^\.\/+/, "");
  if (!path || path.endsWith("/")) return null;
  if (path.split("/").some((p) => p === ".." || p === "." || p === ".git"))
    return null;
  return path;
}

export async function filesFromTarGz(
  chunks: AsyncIterable<Uint8Array>,
): Promise<SourceFile[]> {
  const tooLarge = () =>
    new Error(
      `This repository is too large to copy (${MAX_SOURCE_BYTES / 1024 / 1024} MiB of files max).`,
    );
  const files: SourceFile[] = [];
  let total = 0;
  for await (const entry of tarEntries(
    capped(gunzip(chunks), MAX_SOURCE_BYTES + 1024 * 1024, tooLarge),
    { read: () => true },
  )) {
    const path = stripTopFolder(entry.name);
    if (!path || !entry.bytes) continue;
    total += entry.bytes.length;
    if (total > MAX_SOURCE_BYTES) throw tooLarge();
    if (files.length >= MAX_SOURCE_FILES)
      throw new Error(
        `This repository has too many files to copy (${MAX_SOURCE_FILES} max).`,
      );
    files.push({
      path,
      bytes: entry.bytes,
      executable: (entry.mode & 0o111) !== 0,
    });
  }
  return files;
}

export async function readSourceFiles(
  source: CloneSource,
  ref: string,
): Promise<SourceFile[]> {
  const url = archiveUrl(source, ref);
  await assertSafeOutboundUrl(url, "The repository address");
  const host = new URL(url).host;
  const res = await fetch(url, {
    headers: { "User-Agent": "deplo" },
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
  }).catch(() => {
    throw new Error(`Deplo couldn't download the code from ${host}.`);
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(
      res.status === 404
        ? `${source.fullName} has no branch or tag called ${ref}.`
        : `${host} answered ${res.status} when Deplo downloaded the code.`,
    );
  }
  const files = await filesFromTarGz(
    capped(
      res.body as unknown as AsyncIterable<Uint8Array>,
      MAX_ARCHIVE_BYTES,
      () =>
        new Error(
          `This repository is too large to copy (${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB download max).`,
        ),
    ),
  );
  if (files.length === 0)
    throw new Error(`${source.fullName} has no files on ${ref}.`);
  return files;
}
