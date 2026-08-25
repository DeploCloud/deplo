import { renderUninstallScript } from "@/lib/agent/uninstall-script";

/**
 * Serve the uninstaller. It is a DRY RUN unless the operator passes `--yes`, and
 * it never deletes data without a second explicit `--purge-data` (or
 * `--purge-backups`).
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
