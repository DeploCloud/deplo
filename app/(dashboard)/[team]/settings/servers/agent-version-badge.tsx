"use client";

import { Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  AGENT_TOO_OLD_MESSAGE,
  agentUpdateAvailable,
  agentUsable,
} from "@/lib/version";

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

  if (!agentUsable(version)) {
    return (
      <SimpleTooltip content={AGENT_TOO_OLD_MESSAGE}>
        <Badge variant="destructive">
          <Package className="size-3" />
          Agent too old
        </Badge>
      </SimpleTooltip>
    );
  }

  if (expected && agentUpdateAvailable(version, expected)) {
    return (
      <SimpleTooltip
        content={`This Deplo runs agent v${expected}. Deplo updates this server on its own.`}
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
