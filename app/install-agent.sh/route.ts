import { headers } from "next/headers";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { renderInstallScript } from "@/lib/agent/install-script";

/**
 * Serve the agent installer (PLAN Part B, P2). Public + unauthenticated: it is
 * fetched by `curl | bash` on the target server, which has no session. The
 * binary URL + its sha256 are substituted into the template so the script
 * verifies the binary before running it. Served from the control plane's own
 * domain so it inherits the control plane's TLS (the agent additionally pins the
 * cert fingerprint, P3).
 */
export async function GET() {
  const base = resolvePublicBaseUrl(await headers());
  const script = await renderInstallScript(base);
  if (!script) {
    return new Response(
      "# The Deplo agent binary is not available on this control plane.\n" +
        "# (Built without DEPLO_AGENT_BIN.) Remote servers cannot be provisioned.\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return new Response(script, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
