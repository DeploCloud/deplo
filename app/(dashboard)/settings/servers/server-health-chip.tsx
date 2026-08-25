"use client";

import * as React from "react";
import { CircleHelp, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/shared/status-badge";
import { AGENT_PORT_NOTICE } from "@/components/shared/agent-reachability";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";
import type { ServerStatus } from "@/lib/types";
import {
  isObservationFresh,
  useServerHealth,
  type ServerHealthState,
} from "./server-health-provider";

/**
 * A server's health chip: the status AND how old that status is, because one
 * without the other is a lie waiting to happen.
 */

const LABELS: Record<ServerStatus, string> = {
  online: "Online",
  warning: "Degraded",
  error: "Error",
  offline: "Offline",
  provisioning: "Provisioning",
};

const VARIANTS: Record<
  ServerStatus,
  "success" | "warning" | "destructive" | "muted"
> = {
  online: "success",
  warning: "warning",
  error: "destructive",
  offline: "destructive",
  provisioning: "warning",
};

export function ServerHealthChip({
  serverId,
  fallback,
}: {
  serverId: string;
  /** The stored observation, for the render before the provider's state settles. */
  fallback: ServerHealthState;
}) {
  const { health, isChecking, now } = useServerHealth();
  const state = health(serverId) ?? fallback;
  const checking = isChecking(serverId);

  // `provisioning` is a LIFECYCLE state, not an observation - the prober skips these
  // rows on purpose (there is no agent to dial yet), so they have no checkedAt and
  // must not be aged out into "Unknown".
  if (state.status === "provisioning") {
    return (
      <SimpleTooltip content="Waiting for this server's agent to call home. Run the install command on the host.">
        <Badge variant="warning" className="gap-1.5">
          <StatusDot status="provisioning" />
          Provisioning
        </Badge>
      </SimpleTooltip>
    );
  }

  if (!isObservationFresh(state.checkedAt, now)) {
    // We genuinely do not know. Say so, and say when we last did know, which is the
    // one useful thing an unverified chip can offer.
    const tip = checking
      ? "Checking this server's agent…"
      : state.checkedAt
        ? `Last checked ${timeAgo(state.checkedAt)}. Its status may have changed since.`
        : "This server hasn't been checked yet.";
    return (
      <SimpleTooltip content={tip}>
        <Badge variant="muted" className="gap-1.5">
          {checking ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <CircleHelp className="size-3" />
          )}
          {checking ? "Checking…" : "Unknown"}
        </Badge>
      </SimpleTooltip>
    );
  }

  // `offline` means nothing answered, and by far the most common cause on a host that
  // enrolled fine is a firewall: enrolling is the agent dialing OUT, and this is us
  // dialing IN.
  const tip = [
    state.message,
    state.status === "offline" ? AGENT_PORT_NOTICE : null,
    `Checked ${timeAgo(state.checkedAt!)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SimpleTooltip content={tip}>
      <Badge variant={VARIANTS[state.status]} className="gap-1.5">
        {checking ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <StatusDot status={state.status} />
        )}
        {LABELS[state.status]}
      </Badge>
    </SimpleTooltip>
  );
}
