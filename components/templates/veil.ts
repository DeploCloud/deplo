import { cn } from "@/lib/utils";
import type { LogoAccent } from "@/lib/templates/logo-color";

// veilProps - the wash a card wears in its logo's colour; its own module because `template-card.tsx` is a SERVER component.
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

// plateClass - black-only ink is plated on the dark theme, white-only on the light; the CSS scopes each so the other surface is left alone.
export function plateClass(accent?: LogoAccent): string | undefined {
  if (accent?.tone === "dark") return "tpl-plate-dark";
  if (accent?.tone === "light") return "tpl-plate-light";
  return undefined;
}
