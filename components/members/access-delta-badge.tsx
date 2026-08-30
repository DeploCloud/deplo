// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { ShieldMinus, ShieldPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";

/**
 * "This person is not their role". Two states and no third: amber for less (what
 * an admin auditing access needs to see), blue for more. Nothing renders for
 * everyone who follows their role, so the chip means "look here".
 */
export function AccessDeltaBadge({
  delta,
  roleName,
  className,
}: {
  delta: "less" | "more" | null;
  /** Named in the tooltip, so "than what" is answered without opening anything. */
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
