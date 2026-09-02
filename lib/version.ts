import { version as packageVersion } from "../package.json";

/**
 * Current Deplo (control plane / website) version and upstream repository. This
 * module is client-reachable (the fleet list compares agent versions in it), so
 * nothing server-only may be imported here.
 */
export const DEPLO_VERSION: string = packageVersion;
export const DEPLO_REPO = "DeploCloud/deplo";

/**
 * The agent version we expect every server to be running. This constant is the
 * OFFLINE FALLBACK used only when GitHub can't be reached, and it is what "Update
 * agent" would install then. It lives HERE, not beside the release reader, so the
 * fleet list can compare two versions without pulling a server-only module.
 */
export const FALLBACK_AGENT_VERSION = "0.1.0";
export const EXPECTED_AGENT_VERSION = FALLBACK_AGENT_VERSION;

/** Parse a `[v]MAJOR.MINOR.PATCH[...]` string into a numeric triple, or null. */
function parseSemver(v: string): [number, number, number] | null {
  const m = v
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `latest` is a strictly higher semver than `current`. */
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

/**
 * Whether to offer "Update agent" for a host at all. A host AHEAD of the latest
 * release is not outdated - a moved or deleted tag walks `latest` backwards, and
 * calling that an update advertises a downgrade. Unknown or unparseable: offer it.
 */
export function agentUpdateAvailable(
  reported: string | null,
  expected: string,
): boolean {
  if (!reported || !parseSemver(reported) || !parseSemver(expected))
    return true;
  return isNewer(expected, reported);
}

/**
 * The agent version a server is effectively running, for display.
 */
export function reportedAgentVersion(server: {
  agent?: { version: string };
}): string | null {
  return server.agent?.version || null;
}
