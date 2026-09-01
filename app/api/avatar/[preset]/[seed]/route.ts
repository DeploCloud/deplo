import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/pixelbot.json";

import {
  AVATAR_EDGE_PX,
  isValidPixelbotPreset,
  isValidPixelbotSeed,
  type PixelbotPreset,
} from "@/lib/apps/avatar-shared";

/**
 * The generated profile picture: one deterministic Pixelbot face per seed, in one
 * of the style's own presets. Public on purpose - onboarding shows the picker
 * before an account exists.
 */

export const runtime = "nodejs";

const style = new Style(definition);

/** DiceBear's published option sets for this style, verbatim.
 *  https://www.dicebear.com/styles/pixelbot/presets/ */
const PRESET_OPTIONS: Record<PixelbotPreset, Record<string, unknown>> = {
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
};

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/avatar/[preset]/[seed]">,
) {
  const { preset, seed: raw } = await ctx.params;
  const seed = raw.replace(/\.svg$/, "");
  if (!isValidPixelbotPreset(preset) || !isValidPixelbotSeed(seed))
    return new Response("Not found", { status: 404 });

  // ponytail: rendered per request (~1ms, no I/O); add a cache if a cold fleet
  // ever makes it show up in a profile.
  const svg = new Avatar(style, {
    seed,
    size: AVATAR_EDGE_PX,
    ...PRESET_OPTIONS[preset],
  }).toString();
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      // The preset and the seed ARE the content, so a face never changes under
      // its own URL.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
