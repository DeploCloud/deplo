import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Serve the UNINSTALLER - the counterpart to {@link renderInstallScript}.
 *
 * Removing a server is trust revocation, not a host uninstall: the control plane
 * drops the pinned cert and forgets the row, which is exactly the moment it loses
 * the ability to command that agent. Nothing in the V1 contract can delete the
 * binary, the systemd unit, Traefik or the `deplo` network anyway - and nothing
 * anywhere can delete the control plane itself, which is the machine's own panel.
 * So the cleanup is host-side, and this is the script the operator runs there.
 *
 * Unlike the installer there is nothing to substitute - no binary to fetch, so no
 * URL and no checksum to pin - which is why this returns a plain string and never
 * null: it cannot fail on a GitHub outage the way the installer can.
 *
 * `agentOnly` is the ONE edit: it flips the script's own `AGENT_ONLY` default so
 * the served copy removes the agent and leaves the control plane alone. It exists
 * for the legacy `/uninstall-agent.sh` URL, whose one-liner - already pasted into
 * runbooks before `uninstall.sh` existed - carries no `--agent-only` flag of its
 * own and must keep meaning what it meant when it was copied.
 */
export async function renderUninstallScript(
  opts: { agentOnly?: boolean } = {},
): Promise<string> {
  const script = await readFile(join(process.cwd(), "uninstall.sh"), "utf8");
  if (!opts.agentOnly) return script;

  // Fail loudly rather than serve a script that does more than the caller asked:
  // renaming the variable in the shell script must break the build, not quietly
  // hand somebody a command that takes their panel down.
  const flag = "\nAGENT_ONLY=false\n";
  if (!script.includes(flag)) {
    throw new Error(
      "uninstall.sh no longer declares `AGENT_ONLY=false` on its own line - the agent-only render cannot be applied",
    );
  }
  return script.replace(flag, "\nAGENT_ONLY=true\n");
}
