import "server-only";

/**
 * The agent binary is no longer built inside this repo — it lives in its own
 * repository (AGENT_REPO) and ships as GitHub Release assets. This module is the
 * SINGLE place that resolves "the agent release a new server should install":
 * its tag, the per-arch binary download URL, and the sha256 the install script
 * pins so the operator's box refuses a tampered binary.
 *
 * Policy: ALWAYS LATEST. We resolve `releases/latest` at serve time (cached), so
 * publishing a new agent release immediately becomes what new servers install —
 * no control-plane change needed. To switch to an explicit pin instead, replace
 * the `releases/latest` lookup in fetchLatestRelease with `releases/tags/<tag>`;
 * nothing else here changes.
 *
 * Checksum source: a `checksums.txt` asset published alongside the binaries
 * (one `<sha256>␠␠<filename>` line per asset, the `sha256sum` format). We fetch
 * and parse it rather than trusting the GitHub API's per-asset digest, so the
 * integrity claim comes from the same artifact CI signed off on.
 */

/** The repo that builds + releases the agent binary. */
export const AGENT_REPO = "DeploCloud/deplo-agent";

/**
 * Fallback agent version reported as "expected" when GitHub can't be reached
 * (offline, rate-limited, no releases yet). Kept deliberately conservative: it
 * is only used for the outdated comparison, which treats an unparseable/older
 * "expected" as "nothing is outdated" — so a stale fallback never wrongly flags
 * a healthy agent. Bump it when cutting a release you want reflected offline.
 */
export const FALLBACK_AGENT_VERSION = "1.1.0";

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
 * Parse a `sha256sum`-format checksums file into { filename -> sha256 }. Lines
 * are `<64-hex>␠␠<name>` (two spaces) or `<64-hex> *<name>` (binary mode);
 * anything else is ignored. The filename may carry a leading `./` or path —
 * we key by basename so asset names match regardless of how CI emitted them.
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

/** In-process memo so a single render doesn't fan out to GitHub per field/server. */
let cache: { at: number; release: AgentRelease | null } | null = null;
/**
 * Short TTL: the memo only exists to coalesce the GitHub calls within a single
 * render (many server cards / GraphQL fields resolve the same release). It is NOT
 * a freshness control — a newly cut agent release should surface promptly. 5 min
 * keeps GitHub well under its rate limit while bounding how long a stale "latest"
 * (e.g. a release published seconds after this process cached the prior one) is
 * served. For an immediate refresh use refreshAgentRelease() (the operator's
 * "Check for updates" action) rather than waiting this out.
 */
const CACHE_TTL_MS = 300_000; // 5m

/** A monotonic-ish clock that tolerates environments where Date.now is shimmed. */
function now(): number {
  return Date.now();
}

/**
 * Resolve the latest agent release: its version plus a checksum-pinned download
 * URL per arch. Returns null when GitHub is unreachable or has no usable
 * release/checksums (callers degrade gracefully — the install route 503s, the
 * expected-version resolver falls back to FALLBACK_AGENT_VERSION). Cached for an
 * hour both in-process and via the fetch layer to respect rate limits.
 */
export async function resolveLatestAgentRelease(): Promise<AgentRelease | null> {
  if (cache && now() - cache.at < CACHE_TTL_MS) return cache.release;

  const release = await fetchLatestRelease();
  cache = { at: now(), release };
  return release;
}

/**
 * Force an immediate re-resolution of the latest agent release, bypassing the
 * in-process memo. The production sibling of __resetReleaseCacheForTests: the
 * operator's "Check for updates" action calls this so a release cut moments ago
 * is reflected at once, instead of waiting out CACHE_TTL_MS. Re-populates the
 * memo with the fresh result (so the immediately-following render reuses it) and
 * returns it. Note the underlying fetch still carries `next: { revalidate }`, but
 * that Data Cache is suppressed on the dynamic/cookie'd paths that call this, so
 * clearing the in-process memo is the effective bust.
 */
export async function refreshAgentRelease(): Promise<AgentRelease | null> {
  cache = null;
  return resolveLatestAgentRelease();
}

async function fetchLatestRelease(): Promise<AgentRelease | null> {
  let rel: GitHubRelease;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${AGENT_REPO}/releases/latest`,
      { headers: GH_HEADERS, next: { revalidate: 3600 } },
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
      next: { revalidate: 3600 },
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
  cache = null;
}
