"use client";

import { Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";

export function AgentVersionBadge({ version }: { version: string | null }) {
  if (!version) {
    return (
      <SimpleTooltip content="No agent version reported yet.">
        <Badge variant="muted">
          <Package className="size-3" />
          agent -
        </Badge>
      </SimpleTooltip>
    );
  }

  return (
    <Badge variant="muted">
      <Package className="size-3" />
      agent v{version}
    </Badge>
  );
}
