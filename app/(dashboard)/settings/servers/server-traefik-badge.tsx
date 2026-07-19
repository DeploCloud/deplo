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
 * Whether a Traefik proxy is running on this host — under the SAME honesty rule as the
 * health chip beside it.
 *
 * `servers.traefik_enabled` is a last-known value: it is only ever written from a live
 * Hello, and no path clears it when a host goes away. Rendered raw, it produced the
 * contradiction this component exists to kill — a card reading "Offline" and "Traefik on"
 * at the same time, asserting a fact about a machine nobody could reach. The flag is not
 * wrong, it is just *old*, and a badge that can't say how old it is can only mislead.
 *
 * So the badge asserts only what the last observation actually establishes: Traefik state
 * is painted iff that observation is FRESH and found the server `online`. `warning`
 * (Docker unreachable) is deliberately not enough — the agent forces `traefikRunning`
 * false when it has no container list to look at, so a "Traefik off" there would be a
 * verdict on a question nobody asked (see `observedTraefik` in lib/data/servers.ts).
 *
 * Everything else degrades to "Traefik —", with the last-known value moved into the
 * tooltip where it reads as history instead of as a claim about right now.
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
            ? "Traefik is running on this host — it's the proxy that routes your domains to the apps deployed here."
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

  // We can't see the host, so we can't answer the question. Say what we last knew and
  // when — the one useful thing an unverified badge has to offer. Dated on
  // `lastReachedAt`, NOT on the last check: a failed probe seconds ago is not a sighting,
  // and "last reached 4 seconds ago" under an Offline chip is its own small lie.
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
        Traefik —
      </Badge>
    </SimpleTooltip>
  );
}
