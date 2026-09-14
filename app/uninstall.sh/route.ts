import { renderUninstallScript } from "@/lib/agent/uninstall-script";

// GET serves the uninstaller: a dry run unless `--yes`, and no data deleted without `--purge-data` / `--purge-backups`.
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
