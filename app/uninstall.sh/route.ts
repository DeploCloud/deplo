import { renderUninstallScript } from "@/lib/agent/uninstall-script";

/**
 * Serve the uninstaller. Public + unauthenticated for the same reason the
 * installer is: it is fetched by `curl | bash` on the machine being cleaned up,
 * which has no session. It grants no authority - it only removes Deplo's own
 * footprint from the host it runs on, and it already takes root to do that. It is
 * a DRY RUN unless the operator passes `--yes`, and it never deletes data without
 * a second explicit `--purge-data` (or `--purge-backups`).
 *
 * Note the route must also be excluded from the auth proxy's matcher (proxy.ts),
 * or the cookie-less curl gets a 307 to /login and the operator pipes HTML into
 * bash. The matcher excludes the `uninstall` prefix, which covers both this route
 * and the legacy /uninstall-agent.sh one.
 */
export async function GET() {
  const script = await renderUninstallScript();
  return new Response(script, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
