import { Package } from "lucide-react";
import { LogoImage } from "@/components/shared/project-logo";
import { plateClass, veilProps } from "@/components/templates/veil";
import type { LogoAccent } from "@/lib/templates/logo-color";
import { cn } from "@/lib/utils";

export function LogoTile({
  src,
  accent,
  size,
  logoSize,
  className,
}: {
  src: string | null;
  accent?: LogoAccent;
  size: number;
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
