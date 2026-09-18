"use client";

import * as React from "react";
import { CircleHelp, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/shared/status-badge";
import { AGENT_PORT_NOTICE } from "@/lib/agent-reachability";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";
import type { ServerStatus } from "@/lib/types/server";
import {
  isObservationFresh,
  useServerHealth,
  type ServerHealthState,
} from "./server-health-provider";

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
  fallback: ServerHealthState;
}) {
  const { health, isChecking, now } = useServerHealth();
  const state = health(serverId) ?? fallback;
  const checking = isChecking(serverId);

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

  const tip = [
    state.message,
    state.status === "offline" ? AGENT_PORT_NOTICE : null,
    `Checked ${timeAgo(state.checkedAt!)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  // Online is the resting state: a chip that says "Online" next to a green dot says it twice.
  if (state.status === "online")
    return (
      <SimpleTooltip content={`${LABELS.online} · ${tip}`}>
        <span role="img" aria-label="Online" className="flex items-center">
          {checking ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <StatusDot status="online" />
          )}
        </span>
      </SimpleTooltip>
    );

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
