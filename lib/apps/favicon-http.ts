import { faviconFormatScore, mimeForFaviconPath } from "./favicon-shared";

const MAX_HTML_SCAN = 256 * 1024;

export const MAX_ICON_FETCHES = 6;

const DEFAULT_FAVICON_PATH = "/favicon.ico";

export interface IconLink {
  href: string;
  rel: string[];
  sizes: string;
  type: string;
}

export type IconCandidate =
  | { kind: "path"; path: string }
  | { kind: "inline"; mime: string; bytes: Uint8Array };

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>][^\s>]*))/g;

export function parseIconLinks(html: string): IconLink[] {
  const headEnd = html.slice(0, MAX_HTML_SCAN).search(/<\/head\s*>/i);
  const scope = html.slice(0, headEnd >= 0 ? headEnd : MAX_HTML_SCAN);
  const out: IconLink[] = [];
  for (const tag of scope.match(LINK_TAG_RE) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(ATTR_RE)) {
      attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    }
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!rel.some((r) => r === "icon" || r.startsWith("apple-touch-icon")))
      continue;
    const href = (attrs.href ?? "").trim();
    if (!href) continue;
    out.push({
      href,
      rel,
      sizes: (attrs.sizes ?? "").toLowerCase().trim(),
      type: (attrs.type ?? "").toLowerCase().trim(),
    });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) =>
    e === "amp"
      ? "&"
      : e === "lt"
        ? "<"
        : e === "gt"
          ? ">"
          : e === "quot"
            ? '"'
            : "'",
  );
}

function declaredSize(sizes: string): number {
  if (!sizes) return 0;
  if (sizes.includes("any")) return 1024;
  let best = 0;
  for (const m of sizes.matchAll(/(\d+)\s*[x×]\s*(\d+)/g)) {
    best = Math.max(best, Number(m[1]), Number(m[2]));
  }
  return best;
}

function formatOf(link: IconLink): string {
  if (link.type.startsWith("image/")) {
    const sub = link.type.slice("image/".length);
    if (sub === "svg+xml") return "svg";
    if (sub === "jpeg") return "jpg";
    if (sub === "x-icon" || sub === "vnd.microsoft.icon") return "ico";
    return sub;
  }
  const path = link.href.split(/[?#]/)[0];
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

export function rankIconLinks(links: readonly IconLink[]): IconLink[] {
  return links
    .map((link, i) => ({ link, i }))
    .sort((a, b) => {
      const fa = faviconFormatScore(formatOf(a.link));
      const fb = faviconFormatScore(formatOf(b.link));
      if (fa !== fb) return fb - fa;
      const sa = declaredSize(a.link.sizes);
      const sb = declaredSize(b.link.sizes);
      if (sa !== sb) return sb - sa;
      const ra = a.link.rel.includes("icon") ? 1 : 0;
      const rb = b.link.rel.includes("icon") ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return a.i - b.i;
    })
    .map((e) => e.link);
}

function cleanPath(path: string): string | null {
  const encoded = path.replace(/ /g, "%20");
  if (!encoded.startsWith("/") || encoded.length > 2000) return null;
  if (/[\x00-\x20\x7f]/.test(encoded)) return null;
  return encoded;
}

function joinPath(basePath: string, href: string): string {
  const base = basePath.replace(/\/+$/, "");
  return `${base}/${href.replace(/^\.?\//, "")}`;
}

export function resolveIconHref(
  href: string,
  opts: { basePath: string; host: string },
): IconCandidate | null {
  const raw = href.trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith("data:")) return parseDataUri(raw);
  if (raw.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!opts.host || url.hostname.toLowerCase() !== opts.host.toLowerCase())
      return null;
    const path = cleanPath(url.pathname + url.search);
    return path ? { kind: "path", path } : null;
  }
  const path = cleanPath(
    raw.startsWith("/") ? raw : joinPath(opts.basePath, raw),
  );
  return path ? { kind: "path", path } : null;
}

function parseDataUri(uri: string): IconCandidate | null {
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const meta = uri.slice(5, comma).toLowerCase();
  const payload = uri.slice(comma + 1);
  const mime = normalizeImageMime(meta.split(";")[0]);
  if (!mime) return null;
  try {
    const bytes = meta.includes(";base64")
      ? Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload));
    return bytes.length > 0 ? { kind: "inline", mime, bytes } : null;
  } catch {
    return null;
  }
}

export function iconCandidates(
  html: string,
  opts: { basePath: string; host: string },
): IconCandidate[] {
  const out: IconCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: IconCandidate | null): void => {
    if (!c) return;
    const key =
      c.kind === "path" ? c.path : `inline:${c.mime}:${c.bytes.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const link of rankIconLinks(parseIconLinks(html))) {
    push(resolveIconHref(link.href, opts));
    if (out.length >= MAX_ICON_FETCHES - 1) break;
  }
  const fallback = cleanPath(
    opts.basePath
      ? joinPath(opts.basePath, DEFAULT_FAVICON_PATH)
      : DEFAULT_FAVICON_PATH,
  );
  if (fallback) push({ kind: "path", path: fallback });
  return out.slice(0, MAX_ICON_FETCHES);
}

const MIME_ALIASES: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
  "image/svg+xml": "image/svg+xml",
  "image/svg": "image/svg+xml",
  "image/x-icon": "image/x-icon",
  "image/vnd.microsoft.icon": "image/x-icon",
  "image/ico": "image/x-icon",
  "image/icon": "image/x-icon",
};

function normalizeImageMime(mime: string): string | null {
  return MIME_ALIASES[mime.trim().toLowerCase()] ?? null;
}

function startsWith(
  bytes: Uint8Array,
  sig: readonly number[],
  at = 0,
): boolean {
  return sig.every((b, i) => bytes[at + i] === b);
}

export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp";
  if (
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    (bytes[2] === 1 || bytes[2] === 2) &&
    bytes[3] === 0
  )
    return "image/x-icon";
  return null;
}

function looksLikeSvg(text: string): boolean {
  const head = text.slice(0, 1024).trimStart();
  if (!head.startsWith("<")) return false;
  return /<svg[\s>]/i.test(head);
}

export function imageMimeFor(
  bytes: Uint8Array,
  contentType: string,
  path: string,
): string | null {
  const sniffed = sniffImageMime(bytes);
  if (sniffed) return sniffed;
  const declared = normalizeImageMime(contentType.split(";")[0]);
  const byExtension = mimeForFaviconPath(path.split(/[?#]/)[0]);
  if (declared === "image/svg+xml" || byExtension === "image/svg+xml") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.slice(0, 1024),
    );
    return looksLikeSvg(text) ? "image/svg+xml" : null;
  }
  return null;
}
