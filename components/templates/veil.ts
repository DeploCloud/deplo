import { cn } from "@/lib/utils";
import type { LogoAccent } from "@/lib/templates/logo-color";

/**
 * The wash a card wears in its logo's colour. Its own module because
 * `template-card.tsx` is a SERVER component. A logo with a hue wears it, a
 * neutral one wears its own ink, one that reads as neither renders plain. */
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
