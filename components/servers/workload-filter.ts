import { matchesQuery } from "@/lib/match-query";
import type { DisplayStatus } from "@/lib/apps/display-status";
import type { ServerWorkload } from "@/lib/data/servers/workloads";

export type StatusFilter = "all" | "running" | "stopped" | "failing";
export type KindFilter = "all" | "app" | "database";

const GROUP: Partial<Record<DisplayStatus, StatusFilter>> = {
  active: "running",
  idle: "stopped",
  not_deployed: "stopped",
  stopping: "stopped",
  error: "failing",
  restarting: "failing",
  unhealthy: "failing",
  down: "failing",
};

export function filterWorkloads(
  rows: ServerWorkload[],
  {
    query,
    status,
    kind,
  }: { query: string; status: StatusFilter; kind: KindFilter },
): ServerWorkload[] {
  return rows.filter(
    (w) =>
      (kind === "all" || w.kind === kind) &&
      (status === "all" || GROUP[w.status] === status) &&
      // matchesQuery answers false to an empty query.
      (!query.trim() ||
        matchesQuery(
          query,
          w.name,
          w.teamName,
          w.project ?? "",
          w.environment ?? "",
          w.engine ?? "",
          ...w.containers.map((c) => c.name),
        )),
  );
}
