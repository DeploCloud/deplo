import { renderInstallScript } from "@/lib/agent/install-script";

// GET serves the agent installer; per-arch URLs + sha256s come from the latest agent release, so the script verifies the binary before running it.
export async function GET() {
  const script = await renderInstallScript();
  if (!script) {
    return new Response(
      "# Deplo could not resolve the agent's binary: neither the latest release nor\n" +
        "# the pinned one answered from github.com. Check this machine's outbound\n" +
        "# access to github.com, then run this command again.\n",
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
