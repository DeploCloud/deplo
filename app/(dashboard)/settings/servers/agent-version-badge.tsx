"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";

/**
 * The agent version pill on a server card - a plain fact, never a verdict. The
 * server's actions offer "Update agent" whenever the host is not on the current
 * release (`agentUpdateAvailable`), so this pill never has to nag.
 */
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
