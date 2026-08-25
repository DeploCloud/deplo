import { version as packageVersion } from "../package.json";

import { FALLBACK_AGENT_VERSION } from "./agent/release";

/**
 * Current Deplo (control plane / website) version and upstream repository. Both
 * readers (`lib/data/updates.ts`, `lib/data/instance-settings.ts`) are
 * server-only, so the JSON import never reaches a client bundle.
 */
export const DEPLO_VERSION: string = packageVersion;
export const DEPLO_REPO = "DeploCloud/deplo";

/**
 * The agent version we expect every server to be running. This constant is the
 * OFFLINE FALLBACK used only when GitHub can't be reached, and it is what "Update
 * agent" would install then.
 */
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
 * Whether to offer "Update agent" for a host at all. `isNewer` alone would hide it
 * exactly there. - An agent that reported nothing, or a version this cannot parse,
 * gets the button too.
 */
export function agentUpdateAvailable(
  reported: string | null,
  expected: string,
): boolean {
  const a = reported ? parseSemver(reported) : null;
  const b = parseSemver(expected);
  if (!a || !b) return true;
  return !(a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
}

/**
 * The agent version a server is effectively running, for display.
 */
export function reportedAgentVersion(server: {
  agent?: { version: string };
}): string | null {
  return server.agent?.version || null;
}

/**
 * Resolve the agent version every server should be running — the latest agent
 * GitHub release (DeploCloud/deplo-agent), cached.
 */
export async function resolveExpectedAgentVersion(): Promise<string> {
  const { resolveLatestAgentRelease } = await import("./agent/release");
  const release = await resolveLatestAgentRelease();
  return release?.version || EXPECTED_AGENT_VERSION;
}
