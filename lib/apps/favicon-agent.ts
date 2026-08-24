import "server-only";

import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { composeServicePort, detectDefaultApp } from "../deploy/compose-stack";
import {
  connectAgent,
  AgentUnreachableError,
  type AgentConnection,
  type AgentProbeHttpResult,
} from "../infra/agent-client";
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

/**
 * Favicon auto-detection for an app whose icon lives on its OWNING HOST rather
 * than in a repo or an upload — a **compose stack**. Two places it can be, and
 * this module reads both, because a compose app is either shape:
 *
 *  1. ON DISK, in the app's files dir (`<stacks>/files/<slug>`, the tree every
 *     `./x` bind mount resolves into, which the Files tab browses) — the static
 *     site case, where the stack serves files the user put there.
 *  2. INSIDE THE IMAGE, which is the usual case and the one the files walk can
 *     never see: a stack of prebuilt images keeps its favicon in the image and
 *     only ever SERVES it. That one is read by asking the running app for it,
 *     exactly as a browser would — see {@link detectServedFavicon}.
 *
 * Every read routes through the owning server's agent (ADR-0006 — the control
 * plane never touches a host, not even its own); only the DECIDING is here. The
 * files walk ranks with the shared pure {@link file://./favicon-shared.ts} pick,
 * the served read with {@link file://./favicon-http.ts}.
 *
 * The files walk is two reads, cheapest first:
 *  1. A BOUNDED breadth-first walk over `ListFiles` (metadata only) collects the
 *     `favicon.*` candidates. An app with no favicon costs nothing beyond this,
 *     which is the common case on every deploy.
 *  2. The winner's bytes. `ReadFile` hands back text and REFUSES binary, so it
 *     only serves an SVG; every other favicon comes out of the `ExportFiles` tar
 *     stream, which is read lazily and cancelled the instant the entry lands
 *     (see {@link file://../infra/tar-stream.ts}).
 *
 * Best-effort otherwise: a missing files dir, an unreadable subdirectory, an app
 * that isn't answering, an agent too old for `files-copy` or `http-probe` — all
 * of them just mean "no icon", never an error a deploy has to care about. The
 * single exception is an unreachable server, which is re-raised so the manual
 * action can say so.
 */

/** Directories opened across one walk (each is one RPC round trip). */
const MAX_DIRS_LISTED = 48;
/** How deep below the files root the walk descends (`public/img/icons/…`). */
const MAX_DEPTH = 6;
/** Total entries examined — a hostile/huge tree can't turn this into a crawl. */
const MAX_ENTRIES_SEEN = 20_000;
/** Candidates collected before the walk stops early. */
const MAX_CANDIDATES = 32;
/**
 * Raw archive bytes read from `ExportFiles` before giving up. The stream is
 * cancelled as soon as the wanted entry arrives, so this only bites when the
 * icon sits behind a lot of other data (a media-heavy files dir) — comfortably
 * past any real site's assets, and a hard ceiling on what a cosmetic nicety may
 * cost the host and the wire on a deploy that finds no icon.
 */
const MAX_TAR_SCAN_BYTES = 32 * 1024 * 1024;
/** Hello capability required for the `ExportFiles` stream. */
const FILES_COPY_CAPABILITY = "files-copy";
/** Hello capability required for the `ProbeHttp` read of a running app. */
const HTTP_PROBE_CAPABILITY = "http-probe";
/** How much of an app's home page we ask for. The icon `<link>`s are in the
 * head; this is generous for one and a hard ceiling on what a page can cost. */
const MAX_HTML_BYTES = 256 * 1024;
/** Redirects followed off the home page. Apps that send `/` to `/login` or
 * `/dashboard` are common, and the icon is declared on the page you land on;
 * chasing further than this is a crawl, not a detection. */
const MAX_REDIRECTS = 2;

/** The one agent call the walk needs — narrowed so tests can drive it with a
 * fake tree instead of a live server. `AgentConnection` satisfies it. */
export interface FaviconFileLister {
  listFiles(
    slug: string,
    path: string,
  ): Promise<{ path: string; name: string; kind: string; size: number }[]>;
}

/** The agent calls the byte read needs, narrowed the same way. */
export interface FaviconFileReader {
  readFile(
    slug: string,
    path: string,
  ): Promise<{ text: string | null; size: number }>;
  hello(): Promise<{ capabilities: string[] }>;
  exportFiles(slug: string): AsyncIterable<Buffer>;
}

/**
 * Walk an app's files dir breadth-first and collect the favicon candidates
 * (path + real size), pruning dependency/build dirs on the way down and
 * stopping at every cap above. Breadth-first on purpose: a real site icon sits
 * at the root or one level in (`public/favicon.ico`), so the shallow levels are
 * always covered even when the budget runs out inside a deep tree.
 *
 * A directory that fails to list is skipped, not fatal — one unreadable subdir
 * must not cost the whole scan.
 */
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

/** Gunzip an agent chunk stream, closing BOTH ends when the consumer stops
 * early — that propagates back through the generator to `stream.cancel()`, so
 * abandoning the read actually stops the agent's tar. */
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

/**
 * Read one file out of an app's files dir as raw bytes.
 *
 * An SVG is tried through `ReadFile` first — one small unary call instead of a
 * whole-directory tar, and the only read that works on an agent too old for
 * `files-copy`. It is accepted ONLY when the text round-trips to the exact byte
 * length the agent stat'd: `ReadFile` hands back a UTF-8 string, so a file that
 * isn't valid UTF-8 would come back subtly rewritten, and a re-encoded icon is
 * a corrupted icon. Any mismatch (and every non-SVG) falls through to the
 * `ExportFiles` tar, whose entries the agent writes under a `files/` prefix.
 */
export async function readFilesDirBytes(
  conn: FaviconFileReader,
  slug: string,
  path: string,
): Promise<Buffer | null> {
  if (path.toLowerCase().endsWith(".svg")) {
    // A `reason` (binary / too-large) means the text was withheld — the tar
    // still has the bytes, so fall through rather than give up.
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

/** A detected icon: where it was found, and its bytes. `mime` is set when the
 * source told us the type outright (a served response, whose bytes we sniffed) —
 * a file on disk has only its extension to go on, so it leaves this unset. */
export interface DetectedFaviconBytes {
  path: string;
  bytes: Buffer;
  mime?: string;
}

/**
 * Detect a favicon in an app's files dir on its owning server. Null when the
 * app has no files dir yet, no `favicon.*` in it, or the bytes can't be read.
 *
 * The ONE failure it re-raises is {@link AgentUnreachableError}: "the server
 * didn't answer" is not the same answer as "this app has no icon", and the
 * manual "Detect from source" action says so out loud instead of blaming the
 * user's files. Every automatic caller is fire-and-forget and ignores it.
 */
export async function detectAgentFilesFavicon(
  serverId: string,
  slug: string,
): Promise<DetectedFaviconBytes | null> {
  let conn: AgentConnection | undefined;
  try {
    conn = await connectAgent(serverId);
    // Cheapest possible "is there anything to scan": no files dir ⇒ no walk.
    if (!(await conn.filesExist(slug))) return null;
    const candidates = await collectAgentFaviconCandidates(conn, slug);
    // Sizes come from the listing, so the logo cap is applied BEFORE any byte
    // crosses the wire — an oversized favicon is dropped by the ranker.
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

/* ------------------------------------------------------------------ */
/* The icon a RUNNING app serves                                       */
/* ------------------------------------------------------------------ */

/**
 * Where to reach an app's own web service — everything the agent needs to make
 * the request, and nothing it could turn into an arbitrary address.
 */
export interface ServedIconTarget {
  appId: string;
  slug: string;
  /** Compose service that answers HTTP ("" ⇒ the app's single container). */
  service: string;
  /** Port inside that container. */
  port: number;
  /** The app's own hostname, sent as the Host header ("" ⇒ none). */
  host: string;
  /** Prefix the app is served under, when a domain routes it on a path it does
   * NOT strip. "" for the ordinary whole-host case. */
  basePath: string;
}

/** The routing facts a target is derived from — the shape `RoutableDomain`
 * already has, so a deploy hands its own routes straight over. */
export interface IconProbeRoute {
  name: string;
  service: string | null;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
}

/** The narrowed agent call the served-icon read needs, so tests can drive it
 * with canned responses. `AgentConnection` satisfies it. */
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

/**
 * Work out which container, port and hostname an app's icon should be asked
 * for — the SAME target Traefik was pointed at, so what we read is what a
 * visitor sees.
 *
 * The app's routed domains are authoritative (a domain row names its compose
 * service and port; that pair is what makes the app reachable at all), with the
 * primary preferred so a multi-domain app is read on its canonical host. An app
 * with no domain yet is still probed — it is running, it just isn't published —
 * by falling back to the compose file's own default service, which is exactly
 * what seeded the first domain. Null only when there is no service to talk to.
 */
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
    // A stripped prefix never reaches the container, so the app still serves at
    // its own root; an unstripped one is genuinely part of every URL it sees.
    basePath:
      route && route.pathPrefix && !route.stripPrefix ? route.pathPrefix : "",
  };
}

/** One GET through the agent, or null when the app didn't answer. A probe
 * failure is never fatal: an app that is still booting, listening elsewhere, or
 * refusing the request simply has no icon we can see. */
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

/**
 * Fetch the app's home page, following the redirects an app puts in front of it
 * (`/` → `/login`). Returns the HTML, or null when nothing HTML came back.
 */
async function readHomePage(
  conn: FaviconHttpProber,
  target: ServedIconTarget,
): Promise<string | null> {
  let path = target.basePath ? `${target.basePath.replace(/\/+$/, "")}/` : "/";
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await probe(conn, target, path, MAX_HTML_BYTES);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400 && res.location) {
      // Only ever within this same app: `resolveIconHref` drops an absolute URL
      // pointing anywhere else, which is what keeps a redirect from walking the
      // probe off the app it belongs to.
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

/**
 * Read the icon a RUNNING app serves — the compose-stack arm of favicon
 * detection, and the only one that can work for an app whose files are all
 * inside a prebuilt image.
 *
 * It does what a browser does: read the home page, take the `<link rel="icon">`
 * the app declares about itself (best format and size first), and fall back to
 * `/favicon.ico`. The requests go to the app's own container through its owning
 * server's agent, so this works before DNS resolves, before a certificate is
 * issued, and for an app that was never published at all.
 *
 * Null whenever the app has nothing usable to offer — not running, not
 * answering, no icon declared, or an icon that turns out not to be an image
 * (an SPA answering `/favicon.ico` with its index.html is the common case, and
 * is caught by sniffing the bytes rather than trusting the content type).
 * {@link AgentUnreachableError} is re-raised, as everywhere else: "the server
 * didn't answer" is a different answer from "this app has no icon".
 */
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

/** {@link detectServedFavicon} against an already-open connection — the whole
 * decision, with only the dial removed, so it is drivable with canned responses
 * in a test. */
export async function detectServedFaviconVia(
  conn: FaviconHttpProber,
  target: ServedIconTarget,
): Promise<DetectedFaviconBytes | null> {
  const hello = await conn.hello();
  // An agent too old to reach into the app simply reports no icon — the same
  // "nothing to show" every other dead end yields, never an error.
  if (!hello.capabilities?.includes(HTTP_PROBE_CAPABILITY)) return null;
  const html = await readHomePage(conn, target);
  // No page to read still leaves the well-known path worth one try — plenty of
  // apps serve an API at `/` and their icon at `/favicon.ico` all the same.
  const queue = iconCandidates(html ?? "", {
    basePath: target.basePath,
    host: target.host,
  });
  const tried = new Set<string>();
  // One budget for the whole search, so a chain of redirects can't turn a
  // handful of candidates into a crawl.
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
    // An icon URL that redirects is ordinary (a hashed asset path, a CDN-style
    // rewrite): follow it within this app by making the target the next thing
    // to try, on the same budget.
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = resolveIconHref(res.location, {
        basePath: target.basePath,
        host: target.host,
      });
      if (next && (next.kind === "inline" || !tried.has(next.path)))
        queue.unshift(next);
      continue;
    }
    // `truncated` means the agent cut the body at the logo cap, so what we hold
    // is a fragment of an oversized image — never storable, and never a reason
    // to stop looking at the next candidate.
    if (res.status !== 200 || res.truncated || res.body.length === 0) continue;
    if (res.body.length > MAX_LOGO_BYTES) continue;
    const mime = imageMimeFor(res.body, res.contentType, candidate.path);
    if (!mime) continue;
    return { path: candidate.path, bytes: res.body, mime };
  }
  return null;
}
