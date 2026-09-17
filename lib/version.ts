import { version as packageVersion } from "../package.json";

export const DEPLO_VERSION: string = packageVersion;
export const DEPLO_REPO = "DeploCloud/deplo";

export const FALLBACK_AGENT_VERSION = "0.2.0";

function parseSemver(v: string): [number, number, number] | null {
  const m = v
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

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

export function agentUpdateAvailable(
  reported: string | null,
  expected: string,
): boolean {
  if (!reported || !parseSemver(reported) || !parseSemver(expected))
    return true;
  return isNewer(expected, reported);
}

export function reportedAgentVersion(server: {
  agent?: { version: string };
}): string | null {
  return server.agent?.version || null;
}
