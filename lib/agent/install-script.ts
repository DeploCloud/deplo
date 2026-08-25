import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveLatestAgentRelease } from "./release";

/**
 * Serve the agent installer (PLAN Part B, P2).
 */

/**
 * Render the install script with the binary URL + checksum substituted in.
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
