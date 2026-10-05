import { matchesQuery } from "@/lib/match-query";
import type { DisplayStatus } from "@/lib/apps/display-status";
import type { ServerWorkload } from "@/lib/data/servers/workloads";
import { inAny } from "@/components/shared/facet-filtering";

export type StatusFilter = "running" | "stopped" | "failing";

export const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "running", label: "Running" },
  { value: "stopped", label: "Stopped" },
  { value: "failing", label: "Failing" },
];

export const KIND_OPTIONS: { value: ServerWorkload["kind"]; label: string }[] =
  [
    { value: "app", label: "Apps" },
    { value: "database", label: "Databases" },
  ];

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

export function statusGroup(w: ServerWorkload): StatusFilter | null {
  return GROUP[w.status] ?? null;
}

// Each list is OR within itself, AND across lists; an empty list filters nothing.
export function filterWorkloads(
  rows: ServerWorkload[],
  {
    query,
    statuses,
    kinds,
    teams,
  }: { query: string; statuses: string[]; kinds: string[]; teams: string[] },
): ServerWorkload[] {
  return rows.filter(
    (w) =>
      inAny(kinds, [w.kind]) &&
      inAny(statuses, [statusGroup(w) ?? ""]) &&
      inAny(teams, [w.teamSlug]) &&
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
