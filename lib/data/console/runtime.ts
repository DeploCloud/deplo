import "server-only";

import { composeServiceNames } from "../../deploy/compose-stack/compose-read";
import { connectAgent } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { AgentUnreachableError } from "../../infra/agent-client/errors";
import { requireActiveTeamId } from "../../membership";
import { sweepStale } from "../../stale-sweep";
import type { App } from "../../types/app";
import { loadTeamApp } from "../app-graph-load";
import { listAppMembers } from "../clusters/placement";
import { primaryDomainApp } from "../domains/primary-domain";
import { requireAppCapability } from "../node-access";
import { getServerById } from "../servers/roster";
import { healthOf } from "../../monitoring/answer-health";
import { containerName, ON_SERVER, orderInstances } from "./instances";
import {
  loadOverviewAppStates,
  type OverviewAppState,
} from "./overview-app-states";

export interface RuntimeContainer {
  name: string;
  service: string;
  state: string;
  health: string;
  restartCount: number;
  startedAtUnix: number;
  running: boolean;
  exposed: boolean;
  // Only for an App on several servers: the one this container is on, by name.
  server?: string;
}

export interface AppRuntime {
  total: number;
  running: number;
  restarting: number;
  unhealthy: number;
  missing: string[];
  containers: RuntimeContainer[];
  unreachable: boolean;
  // Only for an App on several servers: the ones that did not answer, by name. The counts leave them out.
  unreachableServers?: string[];
}

const RUNTIME_TTL_MS = 3_000;
const runtimeCache = new Map<string, { at: number; value: AppRuntime }>();

export async function getAppRuntime(appId: string): Promise<AppRuntime | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  await requireAppCapability(appId, "view");

  const hit = runtimeCache.get(p.id);
  if (hit && Date.now() - hit.at < RUNTIME_TTL_MS) return hit.value;

  const value = await probeRuntime(p);
  runtimeCache.set(p.id, { at: Date.now(), value });
  sweepStale(runtimeCache, (e) => e.at, RUNTIME_TTL_MS);
  return value;
}

// Every server that runs the App's replicas is asked; one that does not answer is named, not the whole view.
async function probeRuntime(p: App): Promise<AppRuntime> {
  const memberIds = await listAppMembers(p);
  if (memberIds.length < 2) return probeRuntimeOn(p);
  const parts = await Promise.all(
    memberIds.map(async (id) => ({
      server: await getServerById(id),
      runtime: await probeRuntimeOn({ ...p, serverId: id }),
    })),
  );
  const up = parts.filter((m) => m.server && !m.runtime.unreachable);
  if (up.length === 0) return unknownRuntime();
  const containers = up.flatMap((m) =>
    m.runtime.containers.map((c) => ({
      ...c,
      name: `${c.name}${ON_SERVER}${m.server!.id}`,
      server: m.server!.name,
    })),
  );
  const sum = (f: (r: AppRuntime) => number) =>
    up.reduce((a, m) => a + f(m.runtime), 0);
  return {
    total: containers.length,
    running: sum((r) => r.running),
    restarting: sum((r) => r.restarting),
    unhealthy: sum((r) => r.unhealthy),
    // A service is missing only when no server has it.
    missing: up[0]!.runtime.missing.filter((s) =>
      up.every((m) => m.runtime.missing.includes(s)),
    ),
    containers,
    unreachable: false,
    unreachableServers: parts
      .filter((m) => m.server && m.runtime.unreachable)
      .map((m) => m.server!.name),
  };
}

async function probeRuntimeOn(p: App): Promise<AppRuntime> {
  const exposeService = await primaryDomainApp(p.id);
  let conn: AgentConnection;
  try {
    conn = await connectAgent(p.serverId);
  } catch {
    return unknownRuntime();
  }
  try {
    const instances = orderInstances(
      p,
      await conn.listInstances(p.id, p.slug, exposeService),
    );

    let legacySoloState = "";
    const agentReportsState = instances.some((i) => i.state !== "");
    if (
      !agentReportsState &&
      instances.length === 1 &&
      instances[0].name === containerName(p)
    ) {
      try {
        const seen = await conn.inspect(p.slug);
        if (seen.exists) legacySoloState = seen.state;
      } catch {}
    }

    const containers: RuntimeContainer[] = instances.map((i, idx) => ({
      name: i.name,
      service: i.service,
      state: i.state || (idx === 0 ? legacySoloState : ""),
      health: healthOf(i),
      restartCount: i.restartCount,
      startedAtUnix: i.startedAtUnix,
      running: i.running,
      exposed: i.exposed,
    }));

    const declared = p.compose ? composeServiceNames(p.compose) : [p.slug];
    const present = new Set(containers.map((c) => c.service));
    const missing = declared.filter((s) => !present.has(s));

    return {
      total: containers.length,
      running: containers.filter((c) => c.running).length,
      restarting: containers.filter((c) => c.state === "restarting").length,
      unhealthy: containers.filter((c) => c.running && c.health === "unhealthy")
        .length,
      missing,
      containers,
      unreachable: false,
    };
  } catch (e) {
    if (e instanceof AgentUnreachableError) return unknownRuntime();
    throw e;
  } finally {
    conn.close();
  }
}

function unknownRuntime(): AppRuntime {
  return {
    total: 0,
    running: 0,
    restarting: 0,
    unhealthy: 0,
    missing: [],
    containers: [],
    unreachable: true,
  };
}

export async function getOverviewAppStates(
  requestedIds: string[],
): Promise<OverviewAppState[]> {
  return loadOverviewAppStates(requestedIds, async (appId) => {
    try {
      return (await getAppRuntime(appId)) ?? unknownRuntime();
    } catch {
      return unknownRuntime();
    }
  });
}
