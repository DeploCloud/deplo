import { cn } from "@/lib/utils";

// TintedMark - a glyph tinted with the thing's own accent colour.
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
