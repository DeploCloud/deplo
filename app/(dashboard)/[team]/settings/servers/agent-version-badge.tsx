"use client";

import { Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { stuckAgentMessage } from "@/lib/agent-reachability";
import {
  AGENT_MIN_VERSION,
  AGENT_TOO_OLD_MESSAGE,
  agentUpdateAvailable,
  agentUsable,
  type AgentReach,
} from "@/lib/version";

type AgentBadge = {
  label: string;
  variant: "destructive" | "warning" | "muted";
  tip: string | null;
};

/** What a server's agent badge says, by what can bring the server up to date (ADR-0041). */
export function agentBadge(
  version: string,
  expected: string | undefined,
  reach: AgentReach,
  min: string = AGENT_MIN_VERSION,
): AgentBadge {
  // Nothing Deplo does reaches these: say what does, never that it updates them.
  const stuck = stuckAgentMessage(reach);
  if (!agentUsable(version, min))
    return {
      label: "Agent too old",
      variant: "destructive",
      tip: stuck ?? AGENT_TOO_OLD_MESSAGE,
    };
  if (expected && agentUpdateAvailable(version, expected))
    return {
      label: `agent v${version}`,
      variant: "warning",
      tip:
        stuck ??
        `This Deplo runs agent v${expected}. Deplo updates this server on its own.`,
    };
  return { label: `agent v${version}`, variant: "muted", tip: stuck };
}

export function AgentVersionBadge({
  version,
  expected,
  reach,
}: {
  version: string | null;
  expected?: string;
  reach: AgentReach;
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

  const badge = agentBadge(version, expected, reach);
  const chip = (
    <Badge variant={badge.variant}>
      <Package className="size-3" />
      {badge.label}
    </Badge>
  );
  return badge.tip ? (
    <SimpleTooltip content={badge.tip}>{chip}</SimpleTooltip>
  ) : (
    chip
  );
}
