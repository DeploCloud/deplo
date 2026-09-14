import { ShieldMinus, ShieldPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";

// AccessDeltaBadge marks a member whose access differs from their role: amber for less, blue for more.
export function AccessDeltaBadge({
  delta,
  roleName,
  className,
}: {
  delta: "less" | "more" | null;
  roleName: string | null;
  className?: string;
}) {
  if (!delta) return null;
  const less = delta === "less";
  const Icon = less ? ShieldMinus : ShieldPlus;
  const role = roleName ?? "their role";
  return (
    <SimpleTooltip
      content={
        less
          ? `Someone took access away from them: they can do less than ${role} allows.`
          : `Someone gave them extra access: they can do more than ${role} allows.`
      }
    >
      <Badge variant={less ? "warning" : "info"} className={className}>
        <Icon className="size-3" aria-hidden />
        {less ? "Less than role" : "More than role"}
      </Badge>
    </SimpleTooltip>
  );
}
