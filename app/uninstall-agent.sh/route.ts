import { renderUninstallScript } from "@/lib/agent/uninstall-script";

// Legacy uninstaller URL: older panels print it and runbooks paste the one-liner.
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
