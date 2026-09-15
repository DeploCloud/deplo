import { renderUninstallScript } from "@/lib/agent/uninstall-script";

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
