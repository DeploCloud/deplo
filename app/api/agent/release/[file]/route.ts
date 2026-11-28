import { pinnedBinaryUpstream } from "@/lib/agent/release";

// A server downloads the agent and leader this Deplo pins from Deplo itself, which it already reaches: some reach
// GitHub too slowly to update in time. Public files, so no auth; only the pinned binaries, never another URL.
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/agent/release/[file]">,
) {
  const { file } = await ctx.params;
  const upstream = await pinnedBinaryUpstream(file);
  if (!upstream) return new Response("Not found", { status: 404 });
  const res = await fetch(upstream, {
    headers: { "User-Agent": "deplo-control-plane" },
    cache: "no-store",
  });
  if (!res.ok || !res.body)
    return new Response("The release could not be read from GitHub", {
      status: 502,
    });
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "cache-control": "no-store",
  };
  const length = res.headers.get("content-length");
  if (length) headers["content-length"] = length;
  return new Response(res.body, { headers });
}
