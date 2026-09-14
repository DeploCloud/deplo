"use client";

import { Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";

// AgentVersionBadge is a plain fact, never a verdict: "Update agent" lives in the server's actions (`agentUpdateAvailable`).
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
