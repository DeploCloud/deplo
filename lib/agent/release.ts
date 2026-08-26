import "server-only";

/**
 * The agent binary is no longer built inside this repo - it lives in its own
 * repository (AGENT_REPO) and ships as GitHub Release assets. Policy: ALWAYS
 * LATEST.
 */

/** The repo that builds + releases the agent binary. */
export const AGENT_REPO = "DeploCloud/deplo-agent";

/**
 * Fallback agent version reported as "expected" when GitHub can't be reached
 * (offline, rate-limited, no releases yet).
 */
export const FALLBACK_AGENT_VERSION = "0.1.0";

/** The asset basename the install script downloads, per Linux architecture. */
function assetName(arch: "amd64" | "arm64"): string {
  return `deplo-agent-linux-${arch}`;
}

/** A resolved agent release: everything the install path needs, nothing more. */
export interface AgentRelease {
  /** The release tag, normalized without a leading `v` (e.g. "1.2.0"). */
  version: string;
  /** Map of arch -> { url, sha256 } for each published Linux binary. */
  binaries: Record<"amd64" | "arm64", { url: string; sha256: string } | null>;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}
interface GitHubRelease {
  tag_name?: string;
  assets?: GitHubAsset[];
}

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "deplo-control-plane",
};

/** Strip a single leading v/V so tags ("v1.2.0") and bare versions compare equal. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

/**
 * Parse a `sha256sum`-format checksums file into { filename -> sha256 }.
 */
function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (!m) continue;
    const base = m[2].split("/").pop()!.trim();
    out.set(base, m[1].toLowerCase());
  }
  return out;
}

/**
 * In-process memo so a single render doesn't fan out to GitHub per field/server.
 */
const CACHE_KEY = Symbol.for("deplo.agent.release.cache");
type ReleaseCacheCell = {
  value: { at: number; release: AgentRelease | null } | null;
};
const cacheCell: ReleaseCacheCell = ((globalThis as Record<symbol, unknown>)[
  CACHE_KEY
] ??= { value: null }) as ReleaseCacheCell;
/**
 * Short TTL: the memo only exists to coalesce the GitHub calls within a single
 * render (many server cards / GraphQL fields resolve the same release).
 */
const CACHE_TTL_MS = 300_000; // 5m

/** A monotonic-ish clock that tolerates environments where Date.now is shimmed. */
function now(): number {
  return Date.now();
}

/**
 * Resolve the latest agent release: its version plus a checksum-pinned download
 * URL per arch.
 */
export async function resolveLatestAgentRelease(): Promise<AgentRelease | null> {
  const cache = cacheCell.value;
  if (cache && now() - cache.at < CACHE_TTL_MS) return cache.release;

  const release = await fetchLatestRelease();
  cacheCell.value = { at: now(), release };
  return release;
}

/**
 * Force an immediate re-resolution of the latest agent release, bypassing the
 * in-process memo.
 */
export async function refreshAgentRelease(): Promise<AgentRelease | null> {
  cacheCell.value = null;
  return resolveLatestAgentRelease();
}

async function fetchLatestRelease(): Promise<AgentRelease | null> {
  let rel: GitHubRelease;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${AGENT_REPO}/releases/latest`,
      // no-store: the in-process memo (CACHE_TTL_MS) is the ONLY cache.
      { headers: GH_HEADERS, cache: "no-store" },
    );
    if (!res.ok) return null; // 404 (no releases yet), rate limit, etc.
    rel = (await res.json()) as GitHubRelease;
  } catch {
    return null;
  }

  const tag = typeof rel.tag_name === "string" ? rel.tag_name : null;
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  if (!tag || assets.length === 0) return null;

  // Pull the checksums asset and parse it; without it we cannot pin integrity,
  // so we refuse the release rather than serve an unverifiable binary.
  const checksumAsset = assets.find((a) => a.name === "checksums.txt");
  if (!checksumAsset) return null;
  let sums: Map<string, string>;
  try {
    const res = await fetch(checksumAsset.browser_download_url, {
      headers: { "User-Agent": GH_HEADERS["User-Agent"] },
      // no-store, same rationale as the release fetch above: the memo is the only
      // cache, so this re-resolves with the (fresh) release rather than serving a
      // checksums.txt from a prior release out of the on-disk Data Cache.
      cache: "no-store",
    });
    if (!res.ok) return null;
    sums = parseChecksums(await res.text());
  } catch {
    return null;
  }

  const pick = (arch: "amd64" | "arm64") => {
    const name = assetName(arch);
    const asset = assets.find((a) => a.name === name);
    const sha256 = sums.get(name);
    if (!asset || !sha256) return null;
    return { url: asset.browser_download_url, sha256 };
  };

  const binaries = { amd64: pick("amd64"), arm64: pick("arm64") };
  // At least one arch must be fully resolvable for the release to be usable.
  if (!binaries.amd64 && !binaries.arm64) return null;

  return { version: normalizeTag(tag), binaries };
}

/** Test-only: drop the in-process memo so a test can stub a fresh fetch. */
export function __resetReleaseCacheForTests(): void {
  cacheCell.value = null;
}
