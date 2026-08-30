// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { renderUninstallScript } from "@/lib/agent/uninstall-script";

/**
 * The LEGACY uninstaller URL, kept because the one-liner it serves is pasted into
 * runbooks and printed by every older panel: `curl -fsSL
 * <panel>/uninstall-agent.sh | sudo bash -s -- --yes`.
 */
export async function GET() {
  const script = await renderUninstallScript({ agentOnly: true });
  return new Response(script, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
