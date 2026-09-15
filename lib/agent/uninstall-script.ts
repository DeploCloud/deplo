import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function renderUninstallScript(
  opts: { agentOnly?: boolean } = {},
): Promise<string> {
  const script = await readFile(join(process.cwd(), "uninstall.sh"), "utf8");
  if (!opts.agentOnly) return script;

  const flag = "\nAGENT_ONLY=false\n";
  if (!script.includes(flag)) {
    throw new Error(
      "uninstall.sh no longer declares `AGENT_ONLY=false` on its own line - the agent-only render cannot be applied",
    );
  }
  return script.replace(flag, "\nAGENT_ONLY=true\n");
}
