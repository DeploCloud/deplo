import { cn } from "@/lib/utils";

/**
 * A glyph tinted with the thing's own accent colour — how projects and folders
 * are marked wherever they are listed but not tiled (the scope picker's tree,
 * the Logs picker's tree). No colour means the neutral muted glyph.
 *
 * The colour is stored data (`#rrggbb`), not a theme token, so it is applied as
 * an inline style on purpose: there is no utility for "whatever hex the user
 * picked".
 */
export function TintedMark({
  icon: Icon,
  color,
}: {
  icon: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
  color: string | null;
}) {
  return (
    <Icon
      className={cn("size-3.5", !color && "text-muted-foreground")}
      style={color ? { color } : undefined}
    />
  );
}
