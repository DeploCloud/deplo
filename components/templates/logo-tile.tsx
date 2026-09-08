import { Package } from "lucide-react";
import { LogoImage } from "@/components/shared/project-logo";
import { plateClass, veilProps } from "@/components/templates/veil";
import type { LogoAccent } from "@/lib/templates/logo-color";
import { cn } from "@/lib/utils";

/**
 * A template's logo on its own tile: washed in the logo's own colour, plated
 * when the mark would vanish into the theme. The one renderer for every surface
 * that shows a template - store card, detail page, storefront, create wizard.
 */
export function LogoTile({
  src,
  accent,
  size,
  logoSize,
  className,
}: {
  src: string | null;
  accent?: LogoAccent;
  /** Tile edge in px. */
  size: number;
  /** Logo edge in px, ~2/3 of the tile. */
  logoSize: number;
  className?: string;
}) {
  const veil = veilProps(accent, "on");
  return (
    <div
      style={{ ...veil.style, width: size, height: size }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl border border-border",
        veil.className,
        className,
      )}
    >
      <LogoImage
        src={src}
        size={logoSize}
        className={cn("tpl-logo", plateClass(accent))}
        fallback={<Package className="size-6 text-muted-foreground" />}
      />
    </div>
  );
}
