import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane";
import { requireActiveTeamId } from "../../membership";
import { appCapabilitiesForTeam } from "../node-access";
import { inAppScope } from "../../auth/request-context";
import { GAP_MS } from "../../monitoring/chart-gaps";
import {
  latestContainerInstances,
  latestContainerSample,
} from "../../monitoring/container-history";
import { metricsStreamUnsupported } from "../../monitoring/stream-modes";
import { HEALTH_CHECK_DEFAULTS } from "../../deploy/health-check";
import type { AppStatus } from "../../types";
import type { AppRuntime } from "./index";

export type OverviewRuntime = Pick<
  AppRuntime,
  "total" | "running" | "restarting" | "unhealthy" | "unreachable"
> & {
  maxRestartCount: number;
  unhealthyContainers: string[];
};

export interface OverviewAppState {
  appId: string;
  status: AppStatus;
  neverDeployed: boolean;
  runtime: OverviewRuntime | null;
}

type RuntimeProbe = (appId: string) => Promise<AppRuntime>;

interface FallbackEntry {
  value: AppRuntime;
  refreshAt: number;
  intervalMs: number;
}

interface FallbackJob {
  appId: string;
  intervalMs: number;
  probe: RuntimeProbe;
}

interface FallbackState {
  cache: Map<string, FallbackEntry>;
  queue: FallbackJob[];
  queued: Set<string>;
  running: Set<string>;
}

const FALLBACK_KEY = Symbol.for("deplo.overview-runtime-fallback");
const globalFallback = globalThis as unknown as {
  [FALLBACK_KEY]?: FallbackState;
};
const fallback: FallbackState = (globalFallback[FALLBACK_KEY] ??= {
  cache: new Map(),
  queue: [],
  queued: new Set(),
  running: new Set(),
});

const PROBE_CONCURRENCY = 4;

function fromTelemetry(appId: string, now: number): OverviewRuntime | null {
  const sample = latestContainerSample(appId);
  if (!sample || now - sample.ts > GAP_MS) return null;

  const instances = latestContainerInstances(appId);
  const unhealthy = instances.filter(
    (container) => container.running && container.health === "unhealthy",
  );
  return {
    total: sample.containers,
    running: sample.running,
    restarting: instances.filter((c) => c.state === "restarting").length,
    unhealthy: unhealthy.length,
    maxRestartCount: Math.max(...instances.map((c) => c.restartCount), 0),
    unhealthyContainers: unhealthy.map((c) => c.name),
    unreachable: false,
  };
}

function fromFallback(runtime: AppRuntime): OverviewRuntime {
  const unhealthy = runtime.containers.filter(
    (container) => container.running && container.health === "unhealthy",
  );
  return {
    total: runtime.total,
    running: runtime.running,
    restarting: runtime.restarting,
    unhealthy: runtime.unhealthy,
    maxRestartCount: Math.max(
      ...runtime.containers.map((c) => c.restartCount),
      0,
    ),
    unhealthyContainers: unhealthy.map((c) => c.name),
    unreachable: runtime.unreachable,
  };
}

function mergeHealth(
  telemetry: OverviewRuntime,
  fallbackRuntime: AppRuntime,
): OverviewRuntime {
  if (fallbackRuntime.unreachable) return fromFallback(fallbackRuntime);
  if (
    !fallbackRuntime.containers.some((container) =>
      ["healthy", "unhealthy", "starting"].includes(container.health),
    )
  )
    return telemetry;

  const direct = fromFallback(fallbackRuntime);
  return {
    ...telemetry,
    unhealthy: direct.unhealthy,
    unhealthyContainers: direct.unhealthyContainers,
  };
}

function intervalMs(row: {
  healthCheckEnabled: boolean;
  healthCheckType: string | null;
  healthCheckIntervalS: number | null;
}): number {
  return row.healthCheckEnabled && row.healthCheckType === "http"
    ? Math.max(
        5_000,
        (row.healthCheckIntervalS ?? HEALTH_CHECK_DEFAULTS.intervalS) * 1_000,
      )
    : GAP_MS;
}

function pump(): void {
  while (fallback.running.size < PROBE_CONCURRENCY && fallback.queue.length) {
    const job = fallback.queue.shift()!;
    fallback.queued.delete(job.appId);
    fallback.running.add(job.appId);
    void job
      .probe(job.appId)
      .then(
        (value) => {
          fallback.cache.set(job.appId, {
            value,
            refreshAt: Date.now() + job.intervalMs,
            intervalMs: job.intervalMs,
          });
        },
        () => undefined,
      )
      .finally(() => {
        fallback.running.delete(job.appId);
        pump();
      });
  }
}

function enqueue(appId: string, interval: number, probe: RuntimeProbe): void {
  const hit = fallback.cache.get(appId);
  if (hit && hit.intervalMs === interval && Date.now() < hit.refreshAt) return;
  if (fallback.queued.has(appId) || fallback.running.has(appId)) return;
  fallback.queued.add(appId);
  fallback.queue.push({ appId, intervalMs: interval, probe });
  pump();
}

function prune(activeIds: ReadonlySet<string>): void {
  const now = Date.now();
  for (const [id, entry] of fallback.cache) {
    if (
      !activeIds.has(id) &&
      now >= entry.refreshAt + GAP_MS &&
      !fallback.queued.has(id) &&
      !fallback.running.has(id)
    )
      fallback.cache.delete(id);
  }
}

export async function loadOverviewAppStates(
  requestedIds: string[],
  probe: RuntimeProbe,
): Promise<OverviewAppState[]> {
  const ids = [...new Set(requestedIds.map(String))];
  if (ids.length > 1_000)
    throw new Error("Overview supports at most 1000 distinct apps");
  if (ids.length === 0) return [];

  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({
      id: appsTable.id,
      serverId: appsTable.serverId,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
      status: appsTable.status,
      latestDeploymentId: appsTable.latestDeploymentId,
      healthCheckEnabled: appsTable.healthCheckEnabled,
      healthCheckType: appsTable.healthCheckType,
      healthCheckIntervalS: appsTable.healthCheckIntervalS,
    })
    .from(appsTable)
    .where(
      and(
        eq(appsTable.teamId, teamId),
        inArray(appsTable.id, ids),
        isNull(appsTable.deletingAt),
      ),
    );
  const scoped = rows.filter(inAppScope);
  const capabilities = await appCapabilitiesForTeam(teamId, scoped);
  const visible = scoped.filter(
    (row) => (capabilities.get(row.id)?.length ?? 0) > 0,
  );
  const activeIds = new Set(
    visible.filter((row) => row.status === "active").map((row) => row.id),
  );
  const now = Date.now();
  const telemetry = new Map(
    visible
      .filter((row) => row.status === "active")
      .map((row) => [row.id, fromTelemetry(row.id, now)]),
  );
  const fallbackIds = new Set(
    visible
      .filter((row) => {
        const legacy = metricsStreamUnsupported(row.serverId);
        if (
          row.status !== "active" ||
          (!legacy &&
            telemetry.get(row.id) != null &&
            (!row.healthCheckEnabled || row.healthCheckType !== "http"))
        )
          return false;
        const cached = fallback.cache.get(row.id);
        const fresh =
          cached &&
          cached.intervalMs === intervalMs(row) &&
          now < cached.refreshAt;
        return (
          !fresh &&
          !fallback.queued.has(row.id) &&
          !fallback.running.has(row.id)
        );
      })
      .map((row) => row.id),
  );
  for (const row of visible)
    if (fallbackIds.has(row.id)) enqueue(row.id, intervalMs(row), probe);

  const states = visible.map((row): OverviewAppState => {
    const active = row.status === "active";
    const live = telemetry.get(row.id) ?? null;
    const legacy = metricsStreamUnsupported(row.serverId);
    if (!active) {
      return {
        appId: row.id,
        status: row.status as AppStatus,
        neverDeployed: row.status === "idle" && row.latestDeploymentId == null,
        runtime: null,
      };
    }
    if (
      live &&
      !legacy &&
      (!row.healthCheckEnabled || row.healthCheckType !== "http")
    )
      return {
        appId: row.id,
        status: row.status as AppStatus,
        neverDeployed: false,
        runtime: live,
      };

    const cached = fallback.cache.get(row.id);
    if (cached && live && !legacy) {
      return {
        appId: row.id,
        status: row.status as AppStatus,
        neverDeployed: false,
        runtime: mergeHealth(live, cached.value),
      };
    }
    if (cached) {
      return {
        appId: row.id,
        status: row.status as AppStatus,
        neverDeployed: false,
        runtime: fromFallback(cached.value),
      };
    }
    return {
      appId: row.id,
      status: row.status as AppStatus,
      neverDeployed: false,
      runtime: live,
    };
  });

  prune(activeIds);
  const byId = new Map(states.map((state) => [state.appId, state]));
  return ids.flatMap((id) => {
    const state = byId.get(id);
    return state ? [state] : [];
  });
}
