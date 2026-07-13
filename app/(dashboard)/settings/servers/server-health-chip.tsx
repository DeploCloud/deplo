"use client";

import * as React from "react";
import { CircleHelp, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/shared/status-badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";
import type { ServerStatus } from "@/lib/types";
import {
  STATUS_STALE_MS,
  useServerHealth,
  type ServerHealthState,
} from "./server-health-provider";

/**
 * A server's health chip: the status AND how old that status is, because one without
 * the other is a lie waiting to happen.
 *
 * The rule this component exists to enforce: **a status we haven't confirmed recently
 * is not painted.** Past {@link STATUS_STALE_MS} the chip goes grey "Unknown" no matter
 * what the row says — never a confident green for a server nobody has spoken to since
 * it called home three weeks ago. Green here means "green, and we checked seconds ago".
 *
 * Reaching "Unknown" while the operator sits on the page is therefore a real signal, not
 * a UI timeout: the provider re-sweeps the fleet on an interval well inside the staleness
 * window, so a chip only goes grey when those sweeps are genuinely failing to reach the
 * server agent.
 */

const LABELS: Record<ServerStatus, string> = {
  online: "Online",
  warning: "Degraded",
  error: "Error",
  offline: "Offline",
  provisioning: "Provisioning",
};

const VARIANTS: Record<ServerStatus, "success" | "warning" | "destructive" | "muted"> = {
  online: "success",
  warning: "warning",
  error: "destructive",
  offline: "destructive",
  provisioning: "warning",
};

/**
 * Whether an observation is recent enough to paint. `now` is the provider's clock —
 * `null` until mount (during SSR + the first client render we trust the seed rather
 * than branch on a time the two renders would disagree on), a ticking number after.
 */
function isFresh(checkedAt: string | null, now: number | null): boolean {
  // "Never observed" is deterministic — it does not depend on the clock — so it is
  // decided the same way on the server and the client, no hydration risk.
  if (!checkedAt) return false;
  // Pre-mount (now null): a server with a checkedAt paints its seed. Branching on the
  // actual time is deferred to the client, where the provider's tick supplies `now`.
  if (now === null) return true;
  const at = Date.parse(checkedAt);
  return Number.isFinite(at) && now - at < STATUS_STALE_MS;
}

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

  // `provisioning` is a LIFECYCLE state, not an observation — the prober skips these
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

  if (!isFresh(state.checkedAt, now)) {
    // We genuinely do not know. Say so — and say when we last did know, which is the
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

  const tip = [state.message, `Checked ${timeAgo(state.checkedAt!)}`]
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
