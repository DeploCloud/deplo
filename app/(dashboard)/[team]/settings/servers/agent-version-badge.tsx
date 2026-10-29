"use client";

import { Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { AGENT_REINSTALL_MESSAGE } from "@/lib/agent-reachability";
import {
  AGENT_LINK_VERSION,
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
    // Too old to connect, nothing Deplo does updates it (ADR-0041).
    const why = agentUsable(version, AGENT_LINK_VERSION)
      ? AGENT_TOO_OLD_MESSAGE
      : AGENT_REINSTALL_MESSAGE;
    return (
      <SimpleTooltip content={why}>
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
