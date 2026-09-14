import { version as packageVersion } from "../package.json";

// DEPLO_VERSION - the control plane version; this module is client-reachable, so nothing server-only may be imported here.
export const DEPLO_VERSION: string = packageVersion;
export const DEPLO_REPO = "DeploCloud/deplo";

// FALLBACK_AGENT_VERSION - the agent version to install when GitHub cannot be reached.
export const FALLBACK_AGENT_VERSION = "0.1.0";

function parseSemver(v: string): [number, number, number] | null {
  const m = v
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// isNewer is true when latest is a strictly higher semver than current.
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// agentUpdateAvailable - whether to offer "Update agent"; a host ahead of latest is not outdated, since a moved tag walks latest backwards.
export function agentUpdateAvailable(
  reported: string | null,
  expected: string,
): boolean {
  if (!reported || !parseSemver(reported) || !parseSemver(expected))
    return true;
  return isNewer(expected, reported);
}

// reportedAgentVersion is the agent version a server is effectively running, for display.
export function reportedAgentVersion(server: {
  agent?: { version: string };
}): string | null {
  return server.agent?.version || null;
}
