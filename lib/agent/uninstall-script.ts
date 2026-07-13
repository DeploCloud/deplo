import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Serve the agent UNINSTALLER — the counterpart to {@link renderInstallScript}.
 *
 * Removing a server is trust revocation, not a host uninstall: the control plane
 * drops the pinned cert and forgets the row, which is exactly the moment it loses
 * the ability to command that agent. Nothing in the V1 contract can delete the
 * binary, the systemd unit, Traefik or the `deplo` network anyway. So the host
 * cleanup is host-side, and this is the script the operator runs there.
 *
 * Unlike the installer there is nothing to substitute — no binary to fetch, so no
 * URL and no checksum to pin — which is why this returns a plain string and never
 * null: it cannot fail on a GitHub outage the way the installer can.
 */
export async function renderUninstallScript(): Promise<string> {
  return readFile(join(process.cwd(), "uninstall-agent.sh"), "utf8");
}
