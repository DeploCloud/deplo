import "server-only";

import { AGENT_VERSION, CLUSTER_VERSION, clusterPinned } from "../version";

export const AGENT_REPO = "DeploCloud/deplo-agent";
export const CLUSTER_REPO = "DeploCloud/deplo-cluster";

type Arch = "amd64" | "arm64";

export interface AgentRelease {
  version: string;
  binaries: Record<Arch, { url: string; sha256: string } | null>;
}

const USER_AGENT = "deplo-control-plane";

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

type ReleaseCacheCell = { at: number; release: AgentRelease | null } | null;
const CELL = Symbol.for("deplo.agent.release.cache");
const FAILURE_TTL_MS = 30_000;

function cell(): { value: ReleaseCacheCell } {
  return ((globalThis as Record<symbol, unknown>)[CELL] ??= {
    value: null,
  }) as { value: ReleaseCacheCell };
}

function downloadBase(repo: string, tag: string): string {
  return `https://github.com/${repo}/releases/download/${tag}`;
}

// No api.github.com call: its 60 an hour per instance run out, and an exhausted budget 503'd /install-agent.sh.
export async function fetchPinnedRelease(
  version: string,
  repo: string = AGENT_REPO,
  binary: string = "deplo-agent",
): Promise<AgentRelease | null> {
  const base = downloadBase(repo, `v${version}`);
  let sums: Map<string, string>;
  try {
    const res = await fetch(`${base}/checksums.txt`, {
      headers: { "User-Agent": USER_AGENT },
      cache: "no-store",
    });
    if (!res.ok) return null;
    sums = parseChecksums(await res.text());
  } catch {
    return null;
  }
  const asset = (arch: Arch) => `${binary}-linux-${arch}`;
  const pick = (arch: Arch) => {
    const sha256 = sums.get(asset(arch));
    return sha256 ? { url: `${base}/${asset(arch)}`, sha256 } : null;
  };
  const binaries = { amd64: pick("amd64"), arm64: pick("arm64") };
  if (!binaries.amd64 && !binaries.arm64) return null;
  return { version, binaries };
}

/** The agent release this panel is pinned to (package.json `deplo.agent`). A published tag never changes, so a hit is kept for the process. */
export async function resolveAgentRelease(): Promise<AgentRelease | null> {
  const c = cell();
  if (c.value?.release) return c.value.release;
  if (c.value && Date.now() - c.value.at < FAILURE_TTL_MS) return null;
  const release = await fetchPinnedRelease(AGENT_VERSION);
  c.value = { at: Date.now(), release };
  return release;
}

/** The deplo-cluster release this panel pins (`deplo.cluster`); null while none is released or it cannot be read. */
export async function resolveClusterRelease(
  version: string = CLUSTER_VERSION,
): Promise<AgentRelease | null> {
  if (!clusterPinned(version)) return null;
  const c = clusterCell();
  const hit = c.value[version];
  if (hit?.release) return hit.release;
  if (hit && Date.now() - hit.at < FAILURE_TTL_MS) return null;
  const release = await fetchPinnedRelease(
    version,
    CLUSTER_REPO,
    "deplo-cluster",
  );
  c.value[version] = { at: Date.now(), release };
  return release;
}

const CLUSTER_CELL = Symbol.for("deplo.cluster.release.cache");

function clusterCell(): {
  value: Record<string, NonNullable<ReleaseCacheCell>>;
} {
  return ((globalThis as Record<symbol, unknown>)[CLUSTER_CELL] ??= {
    value: {},
  }) as { value: Record<string, NonNullable<ReleaseCacheCell>> };
}

export function __resetReleaseCacheForTests(): void {
  cell().value = null;
  clusterCell().value = {};
}
