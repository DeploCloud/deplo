import { type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { runWithIdentity } from "@/lib/auth/request-context";
import {
  deploymentTeamId,
  readDeploymentScreenshotImage,
} from "@/lib/data/deployments/screenshot";
import { isCrossSite, crossSiteRefused } from "@/lib/http/same-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/deployments/[id]/screenshot">,
) {
  if (isCrossSite(request)) return crossSiteRefused();
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const theme =
    request.nextUrl.searchParams.get("theme") === "dark" ? "dark" : "light";
  // The deployment's own team, not the last one visited: a second tab may be open on another team.
  const teamId = await deploymentTeamId(id);
  const image = teamId
    ? await runWithIdentity({ userId: user.id, teamId }, () =>
        readDeploymentScreenshotImage(id, theme),
      ).catch(() => null)
    : null;
  if (!image) return Response.json({ error: "Not found" }, { status: 404 });

  return new Response(new Uint8Array(image), {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(image.length),
      // The URL changes with every new picture, so this one never does.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
