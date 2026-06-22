import { resolveLatestAgentRelease } from "@/lib/agent/release";

/**
 * Redirect to the agent binary on GitHub Releases (PixelFederico/deplo-agent).
 *
 * The binary is no longer built into or served by the control plane — it ships
 * as a release asset and the install script downloads it from github.com
 * directly (verifying the sha256 the script pins). This route is kept as a
 * stable alias: older install scripts that still point at
 * `/install-agent/deplo-agent` get 302'd to the current release asset. New
 * scripts skip it and hit GitHub directly.
 *
 * Defaults to the amd64 asset; pass `?arch=arm64` for the other Linux build.
 * Integrity is still guaranteed by the script's checksum check, not by this hop.
 */
export async function GET(req: Request) {
  const arch = new URL(req.url).searchParams.get("arch") === "arm64"
    ? "arm64"
    : "amd64";
  const release = await resolveLatestAgentRelease();
  const target = release?.binaries[arch]?.url;
  if (!target) {
    return new Response("agent binary unavailable", { status: 503 });
  }
  return Response.redirect(target, 302);
}
