import { Avatar, Style } from "@dicebear/core";
import glassDefinition from "@dicebear/styles/glass.json";
import glyphsDefinition from "@dicebear/styles/glyphs.json";
import initialsDefinition from "@dicebear/styles/initials.json";
import pixelbotDefinition from "@dicebear/styles/pixelbot.json";
import planetsDefinition from "@dicebear/styles/planets.json";

import {
  AVATAR_EDGE_PX,
  type AvatarStyle,
  isValidAvatarSeed,
  isValidAvatarStyle,
  isValidPreset,
} from "@/lib/apps/avatar-shared";

/**
 * The generated profile picture: a deterministic picture from the path, in one of
 * DiceBear's own presets. Public on purpose - onboarding shows the picker before
 * an account exists.
 */

export const runtime = "nodejs";

const STYLES: Record<AvatarStyle, Style> = {
  glyphs: new Style(glyphsDefinition),
  planets: new Style(planetsDefinition),
  glass: new Style(glassDefinition),
  pixelbot: new Style(pixelbotDefinition),
  initials: new Style(initialsDefinition),
};

/** DiceBear's published option sets, verbatim; `default` is the style untouched.
 *  https://www.dicebear.com/styles */
const PRESET_OPTIONS: Record<
  AvatarStyle,
  Record<string, Record<string, unknown>>
> = {
  glyphs: { default: {} },
  planets: {
    electric: {
      backgroundColor: ["0a0b0f"],
      planetColor: ["ff2e88", "00e5ff", "ffe600", "7cff00", "b400ff"],
    },
  },
  glass: { default: {} },
  pixelbot: {
    terminal: { backgroundColor: ["0a0f0a"], glowColor: ["4ade80"] },
  },
  initials: {
    default: {},
    greyscale: { backgroundColor: ["343437", "5e5e62", "8c8c90", "b6b6b9"] },
    sunrise: {
      backgroundColor: ["ffd9b0", "ffa8bf"],
      backgroundColorFill: "linear",
      backgroundColorAngle: 135,
    },
    electric: {
      backgroundColor: [
        "ff2e88",
        "00e5ff",
        "ffe600",
        "7cff00",
        "ff6a00",
        "b400ff",
      ],
    },
  },
};

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/avatar/[style]/[preset]/[seed]">,
) {
  const { style, preset, seed: raw } = await ctx.params;
  const seed = raw.replace(/\.svg$/, "");
  if (
    !isValidAvatarStyle(style) ||
    !isValidPreset(style, preset) ||
    !isValidAvatarSeed(seed)
  )
    return new Response("Not found", { status: 404 });

  // A preset the offer list has and this table has not would render the plain
  // style and look like it worked. It is a 404 instead.
  const options = PRESET_OPTIONS[style][preset];
  if (!options) return new Response("Not found", { status: 404 });

  // ponytail: rendered per request (~1ms, no I/O); add a cache if a cold fleet
  // ever makes it show up in a profile.
  const svg = new Avatar(STYLES[style], {
    seed,
    size: AVATAR_EDGE_PX,
    ...options,
  }).toString();
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      // The style, the preset and the seed ARE the content, so a picture never
      // changes under its own URL.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
