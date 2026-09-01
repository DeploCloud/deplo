import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/pixelbot.json";

import { AVATAR_EDGE_PX, isValidPixelbotSeed } from "@/lib/apps/avatar-shared";

/**
 * The generated profile picture: one deterministic Pixelbot face per seed.
 * Public on purpose - onboarding shows the picker before an account exists.
 */

export const runtime = "nodejs";

const style = new Style(definition);

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/avatar/[seed]">,
) {
  const { seed: raw } = await ctx.params;
  const seed = raw.replace(/\.svg$/, "");
  if (!isValidPixelbotSeed(seed))
    return new Response("Not found", { status: 404 });

  // ponytail: rendered per request (~1ms, no I/O); add a cache if a cold fleet
  // ever makes it show up in a profile.
  const svg = new Avatar(style, { seed, size: AVATAR_EDGE_PX }).toString();
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      // The seed IS the content, so a face never changes under its own URL.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
