import "server-only";

import { FALLBACK_AGENT_VERSION } from "../version";

// The agent binary ships as GitHub Release assets from its own repo; the policy is ALWAYS LATEST.

// The repo that builds + releases the agent binary.
export const AGENT_REPO = "DeploCloud/deplo-agent";

export { FALLBACK_AGENT_VERSION } from "../version";

// The asset basename the install script downloads, per Linux architecture.
function assetName(arch: "amd64" | "arm64"): string {
  return `deplo-agent-linux-${arch}`;
}

// A resolved agent release: everything the install path needs, nothing more.
export interface AgentRelease {
  // The release tag, normalized without a leading `v` (e.g. "1.2.0").
  version: string;
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

// Strip a single leading v/V so tags ("v1.2.0") and bare versions compare equal.
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

// The `sha256sum` output format, whose binary mode prefixes the filename with `*`.
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

// In-process memo so a single render doesn't fan out to GitHub per field/server.
const CACHE_KEY = Symbol.for("deplo.agent.release.cache");
type ReleaseCacheCell = {
  value: { at: number; release: AgentRelease | null } | null;
  // The last release that DID resolve: GitHub allows 60 unauthenticated calls an hour per instance, and one blip served `curl | bash` a 503 for five minutes.
  lastGood?: AgentRelease | null;
};
const cacheCell: ReleaseCacheCell = ((globalThis as Record<symbol, unknown>)[
  CACHE_KEY
] ??= { value: null, lastGood: null }) as ReleaseCacheCell;
const CACHE_TTL_MS = 300_000;
// A failure is remembered far more briefly than a success: it is a blip until proven otherwise.
const FAILURE_TTL_MS = 30_000;

// A monotonic-ish clock that tolerates environments where Date.now is shimmed.
function now(): number {
  return Date.now();
}

// Resolve the latest agent release: its version plus a checksum-pinned download URL per arch.
export async function resolveLatestAgentRelease(): Promise<AgentRelease | null> {
  const cache = cacheCell.value;
  const ttl = cache?.release ? CACHE_TTL_MS : FAILURE_TTL_MS;
  if (cache && now() - cache.at < ttl)
    return cache.release ?? cacheCell.lastGood ?? null;

  const release = (await fetchLatestRelease()) ?? (await fetchPinnedRelease());
  cacheCell.value = { at: now(), release };
  if (release) cacheCell.lastGood = release;
  // ponytail: last-good lives in this process only, so a restart while GitHub is
  // unreachable still serves nothing. Persist it if that turns out to matter.
  return release ?? cacheCell.lastGood ?? null;
}

// Force an immediate re-resolution of the latest agent release, bypassing the in-process memo.
export async function refreshAgentRelease(): Promise<AgentRelease | null> {
  cacheCell.value = null;
  return resolveLatestAgentRelease();
}

// NOT the API host: these are plain file downloads, so they do not count against the 60 calls an hour api.github.com allows an instance.
function downloadBase(tag: string): string {
  return `https://github.com/${AGENT_REPO}/releases/download/${tag}`;
}

// The PINNED version, resolved without the API at all: an exhausted API budget used to make `/install-agent.sh` answer 503 mid-install.
async function fetchPinnedRelease(): Promise<AgentRelease | null> {
  const base = downloadBase(`v${FALLBACK_AGENT_VERSION}`);
  let sums: Map<string, string>;
  try {
    const res = await fetch(`${base}/checksums.txt`, {
      headers: { "User-Agent": GH_HEADERS["User-Agent"] },
      cache: "no-store",
    });
    if (!res.ok) return null;
    sums = parseChecksums(await res.text());
  } catch {
    return null;
  }
  const pick = (arch: "amd64" | "arm64") => {
    const sha256 = sums.get(assetName(arch));
    return sha256 ? { url: `${base}/${assetName(arch)}`, sha256 } : null;
  };
  const binaries = { amd64: pick("amd64"), arm64: pick("arm64") };
  if (!binaries.amd64 && !binaries.arm64) return null;
  return { version: FALLBACK_AGENT_VERSION, binaries };
}

async function fetchLatestRelease(): Promise<AgentRelease | null> {
  let rel: GitHubRelease;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${AGENT_REPO}/releases/latest`,
      // no-store: the in-process memo (CACHE_TTL_MS) is the ONLY cache.
      { headers: GH_HEADERS, cache: "no-store" },
    );
    if (!res.ok) return null;
    rel = (await res.json()) as GitHubRelease;
  } catch {
    return null;
  }

  const tag = typeof rel.tag_name === "string" ? rel.tag_name : null;
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  if (!tag || assets.length === 0) return null;

  // Without checksums nothing pins integrity, so the release is refused rather than served as an unverifiable binary.
  const checksumAsset = assets.find((a) => a.name === "checksums.txt");
  if (!checksumAsset) return null;
  let sums: Map<string, string>;
  try {
    const res = await fetch(checksumAsset.browser_download_url, {
      headers: { "User-Agent": GH_HEADERS["User-Agent"] },
      // no-store: otherwise the on-disk Data Cache serves a checksums.txt from a PRIOR release against the fresh one.
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
  if (!binaries.amd64 && !binaries.arm64) return null;

  return { version: normalizeTag(tag), binaries };
}

// Test-only: drop the in-process memo so a test can stub a fresh fetch.
export function __resetReleaseCacheForTests(): void {
  cacheCell.value = null;
  cacheCell.lastGood = null;
}

// The agent version every server should be running: the latest release, or the offline fallback.
// Lives here, not in `lib/version.ts`: that module is client-reachable and importing this one drags `server-only` into the browser bundle.
export async function resolveExpectedAgentVersion(): Promise<string> {
  const release = await resolveLatestAgentRelease();
  return release?.version || FALLBACK_AGENT_VERSION;
}
