// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/**
 * A glyph tinted with the thing's own accent colour - how projects and folders are
 * marked wherever they are listed but not tiled (the scope picker's tree, the Logs
 * picker's tree).
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
