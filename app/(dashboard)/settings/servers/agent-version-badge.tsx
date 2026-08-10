"use client";

import { Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";

/**
 * The agent version pill on a server card — a plain fact, never a verdict.
 *
 * It used to turn amber whenever the reported version was behind the latest
 * GitHub release. That fired on every healthy server the day a release landed,
 * and what actually decides whether a host can do something is the agent's
 * feature list (the readiness report's "Agent features" row), not its version
 * number. "Update agent" is still one click away in the server's actions.
 */
export function AgentVersionBadge({ version }: { version: string | null }) {
  if (!version) {
    return (
      <SimpleTooltip content="No agent version reported yet.">
        <Badge variant="muted">
          <Package className="size-3" />
          agent —
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
