"use client";

import { StatusBadge, StatusDot } from "@/components/shared/status-badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import {
  useDatabaseRuntime,
  type DatabaseRuntimeView,
} from "@/components/storage/use-database-runtime";
import {
  databaseDisplayStatus,
  type DatabaseDisplayStatus,
} from "@/lib/databases/display-status";
import type { DatabaseStatus } from "@/lib/types";

/**
 * The one place a database's badge decides what its state IS: the live
 * subscription (what the control plane last DID) folded with a poll of the
 * owning agent (what the container is actually DOING), via
 * {@link databaseDisplayStatus}. The runtime poll runs only while we claim to
 * be "running" — the only claim it can refute — so a crash-looping engine never
 * reads green.
 */
function useDisplayStatus(
  fallback: DatabaseStatus,
  id: string,
  pollMs?: number,
): { status: DatabaseDisplayStatus; detail: string | null } {
  const status = useLiveDatabaseStatus(fallback);
  const runtime = useDatabaseRuntime(id, {
    enabled: !!id && status === "running",
    pollMs,
  });
  return {
    status: databaseDisplayStatus(status, runtime),
    detail: detailFor(runtime),
  };
}

/** The sentence behind a badge reporting trouble. */
function detailFor(runtime: DatabaseRuntimeView | null): string | null {
  if (!runtime || runtime.unreachable) return null;
  if (runtime.restarting > 0) {
    const restarts = Math.max(...runtime.containers.map((c) => c.restartCount), 0);
    const times = restarts > 0 ? ` It has restarted ${restarts} times.` : "";
    return `Docker keeps restarting this container: it starts, dies, and starts again.${times} The Logs tab shows why.`;
  }
  if (runtime.total === 0)
    return "This database is running, but it has no container on its server. Redeploy to recreate it.";
  if (runtime.running === 0)
    return "This database is meant to be running, but no container is up. The Logs tab shows its last output.";
  if (runtime.unhealthy > 0)
    return "The container is up but failing its healthcheck — running, but the engine isn't answering.";
  return null;
}

/**
 * The database header's labelled status badge — the DB twin of AppStatusBadge.
 * Green "Running", amber pulsing "Provisioning", grey "Stopped", red for
 * error / not-running / crash loop, folding live in real time.
 *
 * On the /storage cards a slower `pollMs` keeps per-card polling light (the 3s
 * server cache absorbs a burst of cards); the detail header uses the default.
 */
export function DatabaseStatusBadge({
  id,
  status,
  pollMs,
}: {
  id: string;
  status: DatabaseStatus;
  pollMs?: number;
}) {
  const { status: shown, detail } = useDisplayStatus(status, id, pollMs);
  const badge = (
    <StatusBadge status={shown} tinted labels={{ running: "Running" }} />
  );
  return detail ? (
    <SimpleTooltip content={detail}>
      <span className="inline-flex">{badge}</span>
    </SimpleTooltip>
  ) : (
    badge
  );
}

/** The dot form (for the /storage list cards). */
export function DatabaseStatusDot({
  id,
  status,
  pollMs,
}: {
  id: string;
  status: DatabaseStatus;
  pollMs?: number;
}) {
  const { status: shown, detail } = useDisplayStatus(status, id, pollMs);
  const dot = <StatusDot status={shown} />;
  return detail ? (
    <SimpleTooltip content={detail}>
      <span className="inline-flex">{dot}</span>
    </SimpleTooltip>
  ) : (
    dot
  );
}
