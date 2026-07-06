import {
  Triangle,
  Flame,
  Rocket,
  Mountain,
  Disc,
  Hexagon,
  Zap,
  Atom,
  Component,
  Shield,
  SquareCode,
  Code2,
  Code,
  Cog,
  Container,
  FileCode2,
  Box,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FRAMEWORKS } from "@/lib/frameworks";
import type { FrameworkId } from "@/lib/types";

/** Real (lucide) icon per framework  monochrome, matches the design system. */
const FRAMEWORK_ICONS: Record<FrameworkId, LucideIcon> = {
  nextjs: Triangle,
  sveltekit: Flame,
  svelte: Flame,
  astro: Rocket,
  nuxt: Mountain,
  remix: Disc,
  gatsby: Hexagon,
  vite: Zap,
  react: Atom,
  vue: Component,
  angular: Shield,
  node: Hexagon,
  python: SquareCode,
  go: Code2,
  rust: Cog,
  php: Code,
  docker: Container,
  static: FileCode2,
  other: Box,
};

export function frameworkIcon(framework: FrameworkId): LucideIcon {
  return FRAMEWORK_ICONS[framework] ?? Box;
}

/** Bare framework glyph (no container)  for inline use in selects and lists. */
export function FrameworkGlyph({
  framework,
  className,
}: {
  framework: FrameworkId;
  className?: string;
}) {
  const Icon = FRAMEWORK_ICONS[framework] ?? Box;
  return <Icon className={cn("size-4 text-muted-foreground", className)} />;
}

export function FrameworkIcon({
  framework,
  size = 32,
  className,
}: {
  framework: FrameworkId;
  size?: number;
  className?: string;
}) {
  const f = FRAMEWORKS[framework] ?? FRAMEWORKS.other;
  const Icon = FRAMEWORK_ICONS[framework] ?? Box;
  return (
    <SimpleTooltip content={f.name}>
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-foreground",
          className,
        )}
        style={{ width: size, height: size }}
      >
        <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
      </span>
    </SimpleTooltip>
  );
}
