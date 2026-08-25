import { renderUninstallScript } from "@/lib/agent/uninstall-script";

/**
 * The LEGACY uninstaller URL, kept because the one-liner it serves is pasted into
 * runbooks and printed by every older panel: `curl -fsSL <panel>/uninstall-agent.sh
 * | sudo bash -s -- --yes`. There is one script now - /uninstall.sh, which removes the
 * control plane too - so this route serves it with `AGENT_ONLY` already flipped.
 * A command copied when it meant "take the agent off this host" keeps meaning
 * exactly that, instead of quietly growing the power to delete somebody's panel.
 *
 * Public + unauthenticated, and excluded from the auth proxy's matcher, for the
 * same reasons as /uninstall.sh.
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
