import { type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { runWithIdentity } from "@/lib/auth/request-context";
import { logoTeamId, readLogoImage } from "@/lib/data/logos";
import { isCrossSite, crossSiteRefused } from "@/lib/http/same-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/logo/[kind]/[id]">,
) {
  if (isCrossSite(request)) return crossSiteRefused();
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { kind, id } = await ctx.params;
  if (kind !== "app" && kind !== "database")
    return Response.json({ error: "Not found" }, { status: 404 });
  // The logo's own team, not the last one visited: a second tab may be open on another team.
  const teamId = await logoTeamId(kind, id);
  const image = teamId
    ? await runWithIdentity({ userId: user.id, teamId }, () =>
        readLogoImage(kind, id),
      ).catch(() => null)
    : null;
  if (!image) return Response.json({ error: "Not found" }, { status: 404 });

  const current = request.nextUrl.searchParams.get("v") === image.version;
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.type,
      "Content-Length": String(image.bytes.length),
      // The URL changes with the image; an old one still answers, but is never kept.
      "Cache-Control": current
        ? "private, max-age=31536000, immutable"
        : "private, no-cache",
      "X-Content-Type-Options": "nosniff",
      // An SVG opened on its own must not run on the panel's origin.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
