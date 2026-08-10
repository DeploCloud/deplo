import { version as packageVersion } from "../package.json";

import { FALLBACK_AGENT_VERSION } from "./agent/release";

/**
 * Current Deplo (control plane / website) version and upstream repository. The
 * dashboard compares this against the latest GitHub release to surface available
 * updates. This is the WEBSITE's version and is independent of the agent version
 * below — they release on their own cadences.
 *
 * Read from package.json rather than written twice. It used to be a literal here,
 * and it drifted the first time it mattered: `chore(release): deplo 1.2.0` bumped
 * package.json, the tag and the image, while this constant stayed at 1.1.0 — so a
 * fully updated instance kept telling its operator "v1.2.0 is available, you have
 * v1.1.0", forever. Both readers (`lib/data/updates.ts`, `lib/data/instance-settings.ts`)
 * are server-only, so the JSON import never reaches a client bundle.
 */
export const DEPLO_VERSION: string = packageVersion;
export const DEPLO_REPO = "IdraDev/deplo";

/**
 * The agent version we expect every server to be running. The agent now lives in
 * its own repo (DeploCloud/deplo-agent) and ships as GitHub releases, so the
 * real "latest" is resolved at runtime via resolveExpectedAgentVersion() — see
 * lib/agent/release.ts. This constant is the OFFLINE FALLBACK used only when
 * GitHub can't be reached, and it is what "Update agent" would install then.
 * Deliberately NOT tied to DEPLO_VERSION.
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
 * The agent version a server is effectively running, for display. Every server (the host running Deplo included) runs an agent
 * installed via install-agent.sh that reports its version on each Hello (cached
 * in `agent.version`); an empty string or absent agent (not-yet-provisioned)
 * collapses to null.
 *
 * Kept here, decoupled from the `Server` type, so the GraphQL resolver and the
 * server-rendered Servers card derive the same value from one rule.
 */
export function reportedAgentVersion(server: {
  agent?: { version: string };
}): string | null {
  return server.agent?.version || null;
}

/**
 * Resolve the agent version every server should be running — the latest agent
 * GitHub release (DeploCloud/deplo-agent), cached. Falls back to the static
 * EXPECTED_AGENT_VERSION when GitHub is unreachable. This is the async successor
 * to the old compile-time EXPECTED_AGENT_VERSION constant: server-side callers
 * (GraphQL resolvers, the Servers RSC) await it once and thread the value into
 * the pure helpers below, which stay synchronous and unit-testable.
 *
 * Kept out of lib/agent/release.ts so that module owns "what release exists" and
 * this one owns "what version we compare against" (they differ only in the
 * fallback). server-only is inherited transitively via release.ts.
 */
export async function resolveExpectedAgentVersion(): Promise<string> {
  const { resolveLatestAgentRelease } = await import("./agent/release");
  const release = await resolveLatestAgentRelease();
  return release?.version || EXPECTED_AGENT_VERSION;
}
