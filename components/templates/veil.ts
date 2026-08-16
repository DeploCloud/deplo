import { cn } from "@/lib/utils";
import type { LogoAccent } from "@/lib/templates/logo-color";

/**
 * The wash a card wears in its logo's colour, and the one number it needs.
 *
 * Written for the template store and now shared with any card that carries a
 * brand mark — Settings → MCP Server's agent picker is the second caller. It
 * lives in its own module for a boring reason: `template-card.tsx` is a SERVER
 * component, so importing these two functions from there would drag it into a
 * client bundle. The CSS behind them is in `globals.css` under "Template store".
 *
 * A logo with a hue wears that hue. A logo drawn in a single neutral has no
 * hue, so it wears its own ink instead (`tpl-veil-neutral`) — a white wordmark
 * lights its card white rather than being the one tile in the grid that stays
 * flat. A logo that reads as neither renders plain.
 *
 * `lit` picks when: `"hover"` while the card is only being pointed at, `"on"`
 * once it is the chosen one (or on a detail page's header, where there is
 * nothing to choose).
 */
export function veilProps(
  accent: LogoAccent | undefined,
  lit: "hover" | "on",
): { style?: React.CSSProperties; className?: string } {
  const when = lit === "on" ? "tpl-veil-on" : "tpl-veil-hover";
  if (accent?.hue !== undefined)
    return {
      style: { "--tpl-hue": accent.hue } as React.CSSProperties,
      className: cn("tpl-veil", when),
    };
  if (accent?.tone) return { className: cn("tpl-veil tpl-veil-neutral", when) };
  return {};
}

/** The plate a logo needs, if any: black-only ink gets one on the dark theme,
 *  white-only ink gets one on the light theme, and the CSS scopes each to its
 *  own theme so the other surface is left alone. */
export function plateClass(accent?: LogoAccent): string | undefined {
  if (accent?.tone === "dark") return "tpl-plate-dark";
  if (accent?.tone === "light") return "tpl-plate-light";
  return undefined;
}
