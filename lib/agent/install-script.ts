import "server-only";

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Serve the agent installer (PLAN Part B, P2). The script template lives at the
 * repo root (`install-agent.sh`, the single source of truth); the control plane
 * fills in the binary download URL + its sha256 at serve time so the script can
 * verify the binary BEFORE running it. The binary is the one baked into the
 * control-plane image at DEPLO_AGENT_BIN (the same one it runs as the local
 * agent), so the version an operator installs always matches the control plane.
 */

const AGENT_BIN = () => process.env.DEPLO_AGENT_BIN || "/usr/local/bin/deplo-agent";

/** Cache the binary bytes + checksum for the process lifetime (it never changes). */
let binCache: { bytes: Buffer; sha256: string } | null = null;

/** Read the agent binary and its sha256, cached. Throws if the binary is absent. */
export async function agentBinary(): Promise<{ bytes: Buffer; sha256: string }> {
  if (binCache) return binCache;
  const bytes = await readFile(AGENT_BIN());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  binCache = { bytes, sha256 };
  return binCache;
}

/**
 * Render the install script with the binary URL + checksum substituted in.
 * `baseUrl` is the control plane's public base URL (from resolvePublicBaseUrl) —
 * the script and binary are both served from it, so an operator who trusts the
 * URL they pasted trusts the whole chain. Returns null if the binary is absent
 * (a tree built without the agent), so the route can 503 with a clear message.
 */
export async function renderInstallScript(
  baseUrl: string,
): Promise<string | null> {
  let sha256: string;
  try {
    ({ sha256 } = await agentBinary());
  } catch {
    return null;
  }
  const template = await readFile(
    join(process.cwd(), "install-agent.sh"),
    "utf8",
  );
  return template
    .replaceAll("__AGENT_BIN_URL__", `${baseUrl}/install-agent/deplo-agent`)
    .replaceAll("__AGENT_SHA256__", sha256);
}
