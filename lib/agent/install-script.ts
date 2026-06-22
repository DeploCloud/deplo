import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveLatestAgentRelease } from "./release";

/**
 * Serve the agent installer (PLAN Part B, P2). The script template lives at the
 * repo root (`install-agent.sh`, the single source of truth). The agent binary
 * is no longer built into the control-plane image — it ships as a GitHub Release
 * asset of PixelFederico/deplo-agent (see lib/agent/release.ts). At serve time we
 * resolve the latest release, substitute the per-arch download URL + the sha256
 * from the release's `checksums.txt`, and the script verifies the binary BEFORE
 * running it. So the chain is: operator trusts the control-plane URL they pasted
 * → that URL serves a script pinning a checksum → the script refuses any binary
 * whose bytes don't match, even though the bytes come from github.com.
 */

/**
 * Render the install script with the binary URL + checksum substituted in.
 * Returns null when no agent release can be resolved (GitHub unreachable, no
 * release, or no checksums asset), so the route can 503 with a clear message
 * rather than serve an unverifiable installer.
 *
 * The binary now comes from GitHub Releases, not the control plane, so this no
 * longer needs the control plane's base URL. The script picks the right arch at
 * runtime (uname -m), so we substitute BOTH the amd64 and arm64 URL+sha pairs;
 * an arch the release didn't publish is left empty and the script errors clearly
 * on that host.
 */
export async function renderInstallScript(): Promise<string | null> {
  const release = await resolveLatestAgentRelease();
  if (!release) return null;

  const amd64 = release.binaries.amd64;
  const arm64 = release.binaries.arm64;
  // At least one arch is guaranteed by resolveLatestAgentRelease (it returns null
  // otherwise), but each individual one may be absent.

  const template = await readFile(
    join(process.cwd(), "install-agent.sh"),
    "utf8",
  );
  return template
    .replaceAll("__AGENT_VERSION__", release.version)
    .replaceAll("__AGENT_URL_AMD64__", amd64?.url ?? "")
    .replaceAll("__AGENT_SHA256_AMD64__", amd64?.sha256 ?? "")
    .replaceAll("__AGENT_URL_ARM64__", arm64?.url ?? "")
    .replaceAll("__AGENT_SHA256_ARM64__", arm64?.sha256 ?? "");
}
