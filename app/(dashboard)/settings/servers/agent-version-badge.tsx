"use client";

import { Package, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";

/**
 * The agent version pill on a server card. Three states:
 *  - up to date     a confidently-current version → neutral pill, "agent v1.0.0"
 *  - outdated       reported version is strictly behind `expected` → warning
 *                   pill naming the latest version, with the upgrade hint in a
 *                   tooltip
 *  - unknown        no version reported yet (a remote whose agent hasn't called
 *                   home, or a non-semver/"dev" build) → muted "agent —" pill;
 *                   we never label something we can't compare as outdated
 *
 * `outdated` is computed by the server (lib/version.isAgentOutdated) and passed
 * in so the badge stays a dumb presenter and the comparison rule lives in one
 * place.
 */
export function AgentVersionBadge({
  version,
  expected,
  outdated,
}: {
  version: string | null;
  expected: string;
  outdated: boolean;
}) {
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

  if (outdated) {
    return (
      <SimpleTooltip
        content={`Agent is out of date — latest is v${expected}. Use "Update agent" in the server's menu to upgrade in place.`}
      >
        <Badge variant="warning">
          <TriangleAlert className="size-3" />
          agent v{version} · latest v{expected}
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
