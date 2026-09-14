import "server-only";

import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import {
  composeServicePort,
  detectDefaultApp,
} from "../deploy/compose-stack/compose-read";
import { connectAgent } from "../infra/agent-client/connect";
import type {
  AgentConnection,
  AgentProbeHttpResult,
} from "../infra/agent-client/connection";
import { AgentUnreachableError } from "../infra/agent-client/errors";
import { readTarEntry } from "../infra/tar-stream";
import {
  iconCandidates,
  imageMimeFor,
  resolveIconHref,
  MAX_ICON_FETCHES,
} from "./favicon-http";
import {
  pickBestFavicon,
  scoreFaviconPath,
  isExcludedDirName,
  type FaviconFile,
} from "./favicon-shared";
import { MAX_LOGO_BYTES } from "./logo-shared";

const MAX_DIRS_LISTED = 48;
const MAX_DEPTH = 6;
const MAX_ENTRIES_SEEN = 20_000;
const MAX_CANDIDATES = 32;
const MAX_TAR_SCAN_BYTES = 32 * 1024 * 1024;
const FILES_COPY_CAPABILITY = "files-copy";
const HTTP_PROBE_CAPABILITY = "http-probe";
const MAX_HTML_BYTES = 256 * 1024;
const MAX_REDIRECTS = 2;

// FaviconFileLister - the one agent call the walk needs, narrowed so tests can drive it.
export interface FaviconFileLister {
  listFiles(
    slug: string,
    path: string,
  ): Promise<{ path: string; name: string; kind: string; size: number }[]>;
}

// FaviconFileReader - the agent calls the byte read needs, narrowed the same way.
export interface FaviconFileReader {
  readFile(
    slug: string,
    path: string,
  ): Promise<{ text: string | null; size: number }>;
  hello(): Promise<{ capabilities: string[] }>;
  exportFiles(slug: string): AsyncIterable<Buffer>;
}

// collectAgentFaviconCandidates - walk an app's files dir and collect the favicon candidates.
export async function collectAgentFaviconCandidates(
  lister: FaviconFileLister,
  slug: string,
): Promise<FaviconFile[]> {
  const found: FaviconFile[] = [];
  const queue: { path: string; depth: number }[] = [{ path: "", depth: 0 }];
  let listed = 0;
  let seen = 0;

  while (
    queue.length > 0 &&
    listed < MAX_DIRS_LISTED &&
    found.length < MAX_CANDIDATES
  ) {
    const dir = queue.shift()!;
    listed++;
    let entries;
    try {
      entries = await lister.listFiles(slug, dir.path);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES_SEEN || found.length >= MAX_CANDIDATES) break;
      if (e.kind === "dir") {
        // The agent already resolved symlinks away and reports only dirs/files.
        if (dir.depth + 1 <= MAX_DEPTH && !isExcludedDirName(e.name)) {
          queue.push({ path: e.path, depth: dir.depth + 1 });
        }
      } else if (e.kind === "file" && scoreFaviconPath(e.path) !== null) {
        found.push({ path: e.path, size: e.size });
      }
    }
    if (seen > MAX_ENTRIES_SEEN) break;
  }
  return found;
}

// Closing BOTH ends on an early exit is what stops the agent's tar.
async function* gunzip(
  chunks: AsyncIterable<Buffer>,
): AsyncGenerator<Uint8Array, void, unknown> {
  const source = Readable.from(chunks);
  const inflated = source.pipe(createGunzip());
  try {
    for await (const chunk of inflated) yield chunk as Uint8Array;
  } finally {
    inflated.destroy();
    source.destroy();
  }
}

// readFilesDirBytes - one file's raw bytes; an SVG tries ReadFile first, the only read an agent without files-copy can do.
export async function readFilesDirBytes(
  conn: FaviconFileReader,
  slug: string,
  path: string,
): Promise<Buffer | null> {
  if (path.toLowerCase().endsWith(".svg")) {
    // Text withheld (binary / too-large) is still in the tar, so fall through.
    const file = await conn.readFile(slug, path).catch(() => null);
    if (file?.text) {
      const bytes = Buffer.from(file.text, "utf8");
      if (bytes.length === file.size) return bytes;
    }
  }
  const hello = await conn.hello();
  if (!hello.capabilities?.includes(FILES_COPY_CAPABILITY)) return null;
  return readTarEntry(gunzip(conn.exportFiles(slug)), {
    name: `files/${path}`,
    maxEntryBytes: MAX_LOGO_BYTES,
    maxScanBytes: MAX_TAR_SCAN_BYTES,
  });
}

// DetectedFaviconBytes - where an icon was found and its bytes; `mime` only when the source stated the type.
export interface DetectedFaviconBytes {
  path: string;
  bytes: Buffer;
  mime?: string;
}

// detectAgentFilesFavicon - a favicon in an app's files dir on its owning server, or null.
export async function detectAgentFilesFavicon(
  serverId: string,
  slug: string,
): Promise<DetectedFaviconBytes | null> {
  let conn: AgentConnection | undefined;
  try {
    conn = await connectAgent(serverId);
    if (!(await conn.filesExist(slug))) return null;
    const candidates = await collectAgentFaviconCandidates(conn, slug);
    // Sizes come from the listing, so the logo cap lands before any byte crosses the wire.
    const best = pickBestFavicon(candidates);
    if (!best) return null;
    const bytes = await readFilesDirBytes(conn, slug, best.path);
    return bytes && bytes.length > 0 ? { path: best.path, bytes } : null;
  } catch (e) {
    if (e instanceof AgentUnreachableError) throw e;
    return null;
  } finally {
    conn?.close();
  }
}

// ServedIconTarget - where to reach an app's own web service, and nothing it could turn into an arbitrary address.
export interface ServedIconTarget {
  appId: string;
  slug: string;
  service: string;
  port: number;
  host: string;
  basePath: string;
}

// IconProbeRoute - the routing facts a target is derived from, the shape `RoutableDomain` already has.
export interface IconProbeRoute {
  name: string;
  service: string | null;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
}

// FaviconHttpProber - the narrowed agent call the served-icon read needs.
export interface FaviconHttpProber {
  hello(): Promise<{ capabilities: string[] }>;
  probeHttp(req: {
    appId: string;
    slug: string;
    service: string;
    port: number;
    path: string;
    host: string;
    maxBytes: number;
  }): Promise<AgentProbeHttpResult>;
}

// servedIconTarget - which container, port and hostname to ask, the same target Traefik was pointed at.
export function servedIconTarget(
  app: { id: string; slug: string; compose: string | null },
  routes: readonly IconProbeRoute[],
  primaryHost: string,
): ServedIconTarget | null {
  const wired = routes.filter((r) => r.service);
  const route =
    wired.find((r) => r.name.toLowerCase() === primaryHost.toLowerCase()) ??
    wired[0] ??
    null;
  const fallback = detectDefaultApp(app.compose);
  const service = route?.service ?? fallback?.service ?? "";
  if (!service) return null;
  const port =
    route?.port ??
    composeServicePort(app.compose, service) ??
    fallback?.port ??
    80;
  return {
    appId: app.id,
    slug: app.slug,
    service,
    port,
    host: route?.name ?? primaryHost ?? "",
    // A stripped prefix never reaches the container; an unstripped one is part of every URL it sees.
    basePath:
      route && route.pathPrefix && !route.stripPrefix ? route.pathPrefix : "",
  };
}

async function probe(
  conn: FaviconHttpProber,
  target: ServedIconTarget,
  path: string,
  maxBytes: number,
): Promise<AgentProbeHttpResult | null> {
  try {
    return await conn.probeHttp({
      appId: target.appId,
      slug: target.slug,
      service: target.service,
      port: target.port,
      path,
      host: target.host,
      maxBytes,
    });
  } catch {
    return null;
  }
}

async function readHomePage(
  conn: FaviconHttpProber,
  target: ServedIconTarget,
): Promise<string | null> {
  let path = target.basePath ? `${target.basePath.replace(/\/+$/, "")}/` : "/";
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await probe(conn, target, path, MAX_HTML_BYTES);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400 && res.location) {
      // resolveIconHref drops an absolute URL elsewhere, so a redirect cannot walk the probe off this app.
      const next = resolveIconHref(res.location, {
        basePath: target.basePath,
        host: target.host,
      });
      if (next?.kind !== "path" || next.path === path) return null;
      path = next.path;
      continue;
    }
    if (res.status !== 200) return null;
    if (!res.contentType.includes("html")) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(res.body);
  }
  return null;
}

// detectServedFavicon - the icon a running app serves, the only arm that works for a prebuilt image.
export async function detectServedFavicon(
  serverId: string,
  target: ServedIconTarget,
): Promise<DetectedFaviconBytes | null> {
  let conn: AgentConnection | undefined;
  try {
    conn = await connectAgent(serverId);
    return await detectServedFaviconVia(conn, target);
  } catch (e) {
    if (e instanceof AgentUnreachableError) throw e;
    return null;
  } finally {
    conn?.close();
  }
}

// detectServedFaviconVia - detectServedFavicon against an already-open connection.
export async function detectServedFaviconVia(
  conn: FaviconHttpProber,
  target: ServedIconTarget,
): Promise<DetectedFaviconBytes | null> {
  const hello = await conn.hello();
  if (!hello.capabilities?.includes(HTTP_PROBE_CAPABILITY)) return null;
  const html = await readHomePage(conn, target);
  const queue = iconCandidates(html ?? "", {
    basePath: target.basePath,
    host: target.host,
  });
  const tried = new Set<string>();
  // One budget for the whole search, so a chain of redirects cannot become a crawl.
  for (let fetches = 0; queue.length > 0 && fetches < MAX_ICON_FETCHES;) {
    const candidate = queue.shift()!;
    if (candidate.kind === "inline") {
      const bytes = Buffer.from(candidate.bytes);
      if (bytes.length > 0 && bytes.length <= MAX_LOGO_BYTES) {
        return { path: "inline", bytes, mime: candidate.mime };
      }
      continue;
    }
    if (tried.has(candidate.path)) continue;
    tried.add(candidate.path);
    fetches++;
    const res = await probe(conn, target, candidate.path, MAX_LOGO_BYTES);
    if (!res) continue;
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = resolveIconHref(res.location, {
        basePath: target.basePath,
        host: target.host,
      });
      if (next && (next.kind === "inline" || !tried.has(next.path)))
        queue.unshift(next);
      continue;
    }
    // `truncated` means the agent cut the body at the logo cap: a fragment, never storable.
    if (res.status !== 200 || res.truncated || res.body.length === 0) continue;
    if (res.body.length > MAX_LOGO_BYTES) continue;
    const mime = imageMimeFor(res.body, res.contentType, candidate.path);
    if (!mime) continue;
    return { path: candidate.path, bytes: res.body, mime };
  }
  return null;
}
