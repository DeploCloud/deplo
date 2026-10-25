import { ShieldAlert, ShieldX, Shield } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { Level } from "@/lib/security-updates/fix-kind";

export const LEVEL_META: Record<
  Level,
  {
    label: string;
    icon: typeof Shield;
    variant: "destructive" | "warning" | "muted";
  }
> = {
  exploited: {
    label: "Used in attacks",
    icon: ShieldX,
    variant: "destructive",
  },
  critical: { label: "Critical", icon: ShieldAlert, variant: "warning" },
  high: { label: "Important", icon: Shield, variant: "muted" },
};

export function SecurityLevelBadge({ level }: { level: Level }) {
  const m = LEVEL_META[level];
  return (
    <Badge variant={m.variant} className="shrink-0">
      <m.icon className="size-3" />
      {m.label}
    </Badge>
  );
}
