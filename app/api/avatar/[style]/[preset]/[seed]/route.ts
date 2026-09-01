import { Avatar, Style } from "@dicebear/core";
import pixelbotDefinition from "@dicebear/styles/pixelbot.json";
import initialsDefinition from "@dicebear/styles/initials.json";

import {
  AVATAR_EDGE_PX,
  type AvatarStyle,
  isValidAvatarSeed,
  isValidAvatarStyle,
  isValidPreset,
} from "@/lib/apps/avatar-shared";

/**
 * The generated profile picture: a deterministic face or monogram, in one of the
 * style's own presets. Public on purpose - onboarding shows the picker before an
 * account exists.
 */

export const runtime = "nodejs";

const STYLES: Record<AvatarStyle, Style> = {
  pixelbot: new Style(pixelbotDefinition),
  initials: new Style(initialsDefinition),
};

/** DiceBear's published option sets for these styles, verbatim.
 *  https://www.dicebear.com/styles/pixelbot/presets/ */
const PRESET_OPTIONS: Record<
  AvatarStyle,
  Record<string, Record<string, unknown>>
> = {
  pixelbot: {
    default: {},
    terminal: { backgroundColor: ["0a0f0a"], glowColor: ["4ade80"] },
    amber: { backgroundColor: ["120c05"], glowColor: ["ffb020"] },
    greyscale: {
      backgroundColor: ["141416"],
      glowColor: ["f4f4f5", "d4d4d8", "a1a1aa"],
    },
    duotone: { backgroundColor: ["061626"], glowColor: ["22d3ee"] },
    electric: {
      backgroundColor: ["000000"],
      glowColor: ["ff2e88", "00e5ff", "7cff00", "ffe600", "ff6a00", "b400ff"],
    },
    cool: {
      backgroundColor: ["0b1220"],
      glowColor: ["7dd3fc", "5eead4", "a5b4fc", "c4b5fd", "67e8f9"],
    },
    warm: {
      backgroundColor: ["1a0d06"],
      glowColor: ["fdba74", "fcd34d", "fca5a5", "fb923c", "f9a8d4"],
    },
    sunrise: {
      backgroundColor: ["1e1b4b", "3b0764"],
      backgroundColorFill: "linear",
      backgroundColorAngle: 45,
      glowColor: ["fde68a", "f9a8d4", "c4b5fd"],
    },
  },
  initials: {
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
    greyscale: {
      backgroundColor: ["343437", "5e5e62", "8c8c90", "b6b6b9"],
    },
    sunrise: {
      backgroundColor: ["ffd9b0", "ffa8bf"],
      backgroundColorFill: "linear",
      backgroundColorAngle: 135,
    },
    duotone: { backgroundColor: ["3d4272"] },
    "bold-pop": {
      backgroundColor: ["ff5d8f", "ffb703", "43aa8b", "4d96ff", "b57bff"],
    },
    sepia: { backgroundColor: ["8a6a48", "6b4f35", "a3855f", "54402c"] },
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

  // ponytail: rendered per request (~1ms, no I/O); add a cache if a cold fleet
  // ever makes it show up in a profile.
  const svg = new Avatar(STYLES[style], {
    seed,
    size: AVATAR_EDGE_PX,
    ...PRESET_OPTIONS[style][preset],
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
