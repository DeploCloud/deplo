import { FALLBACK_AGENT_VERSION } from "./agent/release";

/**
 * Current Deplo (control plane / website) version and upstream repository. The
 * dashboard compares this against the latest GitHub release to surface available
 * updates. This is the WEBSITE's version and is independent of the agent version
 * below — they release on their own cadences.
 */
export const DEPLO_VERSION = "1.0.0";
export const DEPLO_REPO = "IdraDev/deplo";

/**
 * The agent version we expect every server to be running. The agent now lives in
 * its own repo (PixelFederico/deplo-agent) and ships as GitHub releases, so the
 * real "latest" is resolved at runtime via resolveExpectedAgentVersion() — see
 * lib/agent/release.ts. This constant is the OFFLINE FALLBACK used only when
 * GitHub can't be reached; it must stay a conservative value, because the
 * outdated check treats an unparseable/older "expected" as "nothing is outdated"
 * (so a stale fallback never wrongly flags a healthy agent). Deliberately NOT
 * tied to DEPLO_VERSION.
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
 * Whether a server's reported agent version is older than what we expect. A
 * non-semver or empty version (e.g. "dev", or a not-yet-seen agent) is treated
 * as NOT outdated — we only flag a version we can confidently compare and prove
 * is behind, never a placeholder we can't reason about.
 */
export function isAgentOutdated(
  agentVersion: string | null | undefined,
  expected: string = EXPECTED_AGENT_VERSION,
): boolean {
  if (!agentVersion) return false;
  return isNewer(expected, agentVersion);
}

/**
 * The agent version a server is effectively running, for display and the
 * outdated check. localhost's agent is supervised in-process and shares the
 * control plane's binary, so it is the expected version by definition — its
 * stored `agent.version` (if any) is a diagnostic relic and must not be used.
 * A remote reports its version on each Hello (cached in `agent.version`); an
 * empty string or absent agent (not-yet-provisioned) collapses to null.
 *
 * Kept here, decoupled from the `Server` type, so the GraphQL resolver and the
 * server-rendered Servers card derive the same value from one rule.
 */
export function reportedAgentVersion(
  server: {
    type: "localhost" | "remote";
    agent?: { version: string };
  },
  expected: string = EXPECTED_AGENT_VERSION,
): string | null {
  if (server.type === "localhost") return expected;
  return server.agent?.version || null;
}

/**
 * Resolve the agent version every server should be running — the latest agent
 * GitHub release (PixelFederico/deplo-agent), cached. Falls back to the static
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
