"use client";

import { Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { agentUpdateAvailable } from "@/lib/version";

export function AgentVersionBadge({
  version,
  expected,
}: {
  version: string | null;
  expected?: string;
}) {
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

  if (expected && agentUpdateAvailable(version, expected)) {
    return (
      <SimpleTooltip
        content={`This server is behind the fleet, which runs agent v${expected}. Deplo updates it on its own after a panel update.`}
      >
        <Badge variant="warning">
          <Package className="size-3" />
          agent v{version}
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
