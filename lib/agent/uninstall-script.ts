import "server-only";

// https://deplo.build/docs/operations/remove-a-server-or-uninstall

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Serve the UNINSTALLER, the counterpart to renderInstallScript.
export async function renderUninstallScript(
  opts: { agentOnly?: boolean } = {},
): Promise<string> {
  const script = await readFile(join(process.cwd(), "uninstall.sh"), "utf8");
  if (!opts.agentOnly) return script;

  // Renaming this variable in the shell script must break loudly, not quietly hand somebody a command that takes their panel down.
  const flag = "\nAGENT_ONLY=false\n";
  if (!script.includes(flag)) {
    throw new Error(
      "uninstall.sh no longer declares `AGENT_ONLY=false` on its own line - the agent-only render cannot be applied",
    );
  }
  return script.replace(flag, "\nAGENT_ONLY=true\n");
}
