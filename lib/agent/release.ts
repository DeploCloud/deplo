import "server-only";

import { FALLBACK_AGENT_VERSION } from "../version";

export const AGENT_REPO = "DeploCloud/deplo-agent";

export { FALLBACK_AGENT_VERSION } from "../version";

function assetName(arch: "amd64" | "arm64"): string {
  return `deplo-agent-linux-${arch}`;
}

export interface AgentRelease {
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

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

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

const CACHE_KEY = Symbol.for("deplo.agent.release.cache");
type ReleaseCacheCell = {
  value: { at: number; release: AgentRelease | null } | null;
  lastGood?: AgentRelease | null;
};
const cacheCell: ReleaseCacheCell = ((globalThis as Record<symbol, unknown>)[
  CACHE_KEY
] ??= { value: null, lastGood: null }) as ReleaseCacheCell;
const CACHE_TTL_MS = 300_000;
const FAILURE_TTL_MS = 30_000;

function now(): number {
  return Date.now();
}

export async function resolveLatestAgentRelease(): Promise<AgentRelease | null> {
  const cache = cacheCell.value;
  const ttl = cache?.release ? CACHE_TTL_MS : FAILURE_TTL_MS;
  if (cache && now() - cache.at < ttl)
    return cache.release ?? cacheCell.lastGood ?? null;

  const release = (await fetchLatestRelease()) ?? (await fetchPinnedRelease());
  cacheCell.value = { at: now(), release };
  if (release) cacheCell.lastGood = release;
  // ponytail: last-good lives in this process only, so a restart while GitHub is
  return release ?? cacheCell.lastGood ?? null;
}

export async function refreshAgentRelease(): Promise<AgentRelease | null> {
  cacheCell.value = null;
  return resolveLatestAgentRelease();
}

function downloadBase(tag: string): string {
  return `https://github.com/${AGENT_REPO}/releases/download/${tag}`;
}

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

  const checksumAsset = assets.find((a) => a.name === "checksums.txt");
  if (!checksumAsset) return null;
  let sums: Map<string, string>;
  try {
    const res = await fetch(checksumAsset.browser_download_url, {
      headers: { "User-Agent": GH_HEADERS["User-Agent"] },
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

export function __resetReleaseCacheForTests(): void {
  cacheCell.value = null;
  cacheCell.lastGood = null;
}

export async function resolveExpectedAgentVersion(): Promise<string> {
  const release = await resolveLatestAgentRelease();
  return release?.version || FALLBACK_AGENT_VERSION;
}
