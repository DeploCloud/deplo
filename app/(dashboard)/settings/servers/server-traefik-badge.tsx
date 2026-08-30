"use client";

import * as React from "react";
import { CircleHelp, Network } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";
import {
  isObservationFresh,
  useServerHealth,
  type ServerHealthState,
} from "./server-health-provider";

/**
 * Whether a Traefik proxy is running on this host - under the SAME honesty rule as
 * the health chip beside it. The flag is not wrong, it is just *old*, and a badge
 * that can't say how old it is can only mislead.
 */
export function ServerTraefikBadge({
  serverId,
  fallback,
}: {
  serverId: string;
  /** The stored observation, for the render before the provider's state settles. */
  fallback: ServerHealthState;
}) {
  const { health, now } = useServerHealth();
  const state = health(serverId) ?? fallback;

  if (state.status === "online" && isObservationFresh(state.checkedAt, now)) {
    return (
      <SimpleTooltip
        content={
          state.traefikEnabled
            ? "Traefik is running on this host - it's the proxy that routes your domains to the apps deployed here."
            : "No Traefik proxy is running on this host. Apps deployed here won't be reachable by domain until one is."
        }
      >
        <Badge variant={state.traefikEnabled ? "success" : "muted"}>
          <Network className="size-3" />
          Traefik {state.traefikEnabled ? "on" : "off"}
        </Badge>
      </SimpleTooltip>
    );
  }

  // We can't see the host, so we can't answer the question.
  const lastKnown = state.traefikEnabled ? "running" : "not running";
  const tip =
    state.status === "provisioning"
      ? "Deplo will check for a Traefik proxy once this server's agent calls home."
      : state.lastReachedAt
        ? `Deplo can't check this while the server is unreachable. Traefik was ${lastKnown} when this server was last reached, ${timeAgo(state.lastReachedAt)}.`
        : "Deplo hasn't been able to reach this server yet, so it can't tell whether Traefik is running.";

  return (
    <SimpleTooltip content={tip}>
      <Badge variant="muted">
        <CircleHelp className="size-3" />
        Traefik -
      </Badge>
    </SimpleTooltip>
  );
}
