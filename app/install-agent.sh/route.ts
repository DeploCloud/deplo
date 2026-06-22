import { renderInstallScript } from "@/lib/agent/install-script";

/**
 * Serve the agent installer (PLAN Part B, P2). Public + unauthenticated: it is
 * fetched by `curl | bash` on the target server, which has no session. The
 * per-arch binary URLs + their sha256s are resolved from the latest GitHub
 * release of the agent and substituted into the template, so the script verifies
 * the binary before running it. Served from the control plane's own domain so it
 * inherits the control plane's TLS (the agent additionally pins the cert
 * fingerprint, P3); the binary itself is fetched from GitHub Releases.
 */
export async function GET() {
  const script = await renderInstallScript();
  if (!script) {
    return new Response(
      "# The Deplo agent release could not be resolved (GitHub unreachable, or no\n" +
        "# published release/checksums). Remote servers cannot be provisioned yet.\n",
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
