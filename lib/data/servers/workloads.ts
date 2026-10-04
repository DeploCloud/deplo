import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { requireInstanceAdmin, teamsForUser } from "../../membership";
import { displayStatus, type DisplayStatus } from "../../apps/display-status";
import { GAP_MS } from "../../monitoring/chart-gaps";
import {
  latestContainerInstances,
  latestContainerSample,
} from "../../monitoring/container-history";
import { fromTelemetry } from "../console/overview-app-states";
import type { AppStatus } from "../../types/app";
import type { DatabaseStatus } from "../../types/database";

export type WorkloadContainer = {
  name: string;
  state: string;
  health: string;
  cpu: number;
  memUsed: number;
  restartCount: number;
};

export type ServerWorkload = {
  id: string;
  kind: "app" | "database";
  name: string;
  logo: string | null;
  logoTone: "dark" | "light" | null;
  // A database's engine ("postgres"); null for an app.
  engine: string | null;
  teamName: string;
  // Null when the viewer is not in the owning team, so there is no page to open.
  href: string | null;
  project: string | null;
  environment: string | null;
  domain: string | null;
  status: DisplayStatus;
  cpu: number | null;
  memUsed: number | null;
  restarts: number;
  containers: WorkloadContainer[];
};

const DATABASE_STATUS: Record<DatabaseStatus, AppStatus> = {
  running: "active",
  stopped: "idle",
  provisioning: "building",
  error: "error",
};

// ponytail: stream telemetry only; the overview's probe fallback (old agents, http checks) is skipped.
function live(id: string, status: AppStatus, neverDeployed: boolean) {
  const now = Date.now();
  const sample = latestContainerSample(id);
  const fresh = sample != null && now - sample.ts <= GAP_MS;
  const runtime = status === "active" ? fromTelemetry(id, now) : null;
  const containers = fresh
    ? latestContainerInstances(id).map((c) => ({
        name: c.name,
        state: c.state || (c.running ? "running" : "exited"),
        health: c.health,
        cpu: c.cpu,
        memUsed: c.memUsed,
        restartCount: c.restartCount,
      }))
    : [];
  const up = fresh && sample.running > 0;
  return {
    status: displayStatus(
      status,
      runtime && { ...runtime, missing: [] },
      neverDeployed,
    ),
    cpu: up ? sample.cpu : null,
    memUsed: up ? sample.memUsed : null,
    restarts: containers.reduce((n, c) => n + c.restartCount, 0),
    containers,
  };
}

const tone = (t: string | null): "dark" | "light" | null =>
  t === "dark" || t === "light" ? t : null;

// Every team's apps and databases: a server is shared, and only an instance admin reads this.
export async function listServerWorkloads(
  serverId: string,
): Promise<ServerWorkload[]> {
  const { userId } = await requireInstanceAdmin();
  const db = getDb();
  const [apps, databases, mine] = await Promise.all([
    db
      .select({
        id: appsTable.id,
        name: appsTable.name,
        slug: appsTable.slug,
        logo: appsTable.logo,
        logoTone: appsTable.logoTone,
        status: appsTable.status,
        latestDeploymentId: appsTable.latestDeploymentId,
        productionUrl: appsTable.productionUrl,
        teamId: teamsTable.id,
        teamName: teamsTable.name,
        teamSlug: teamsTable.slug,
        project: projectsTable.name,
        environment: environmentsTable.name,
      })
      .from(appsTable)
      .innerJoin(teamsTable, eq(teamsTable.id, appsTable.teamId))
      .leftJoin(projectsTable, eq(projectsTable.id, appsTable.projectId))
      .leftJoin(
        environmentsTable,
        eq(environmentsTable.id, appsTable.environmentId),
      )
      .where(
        and(eq(appsTable.serverId, serverId), isNull(appsTable.deletingAt)),
      ),
    db
      .select({
        id: databasesTable.id,
        name: databasesTable.name,
        logo: databasesTable.logo,
        engine: databasesTable.type,
        status: databasesTable.status,
        teamId: teamsTable.id,
        teamName: teamsTable.name,
        teamSlug: teamsTable.slug,
        project: projectsTable.name,
        environment: environmentsTable.name,
      })
      .from(databasesTable)
      .innerJoin(teamsTable, eq(teamsTable.id, databasesTable.teamId))
      .leftJoin(
        environmentsTable,
        eq(environmentsTable.id, databasesTable.environmentId),
      )
      .leftJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(eq(databasesTable.serverId, serverId)),
    teamsForUser(userId),
  ]);
  const member = new Set(mine.map((t) => t.id));
  const page = (teamId: string, slug: string, path: string) =>
    member.has(teamId) ? `/${slug}${path}` : null;

  const rows: ServerWorkload[] = [
    ...apps.map((a) => ({
      id: a.id,
      kind: "app" as const,
      name: a.name,
      logo: a.logo,
      logoTone: tone(a.logoTone),
      engine: null,
      teamName: a.teamName,
      href: page(a.teamId, a.teamSlug, `/apps/${a.slug}`),
      project: a.project,
      environment: a.environment,
      domain: a.productionUrl,
      ...live(
        a.id,
        a.status as AppStatus,
        a.status === "idle" && a.latestDeploymentId == null,
      ),
    })),
    ...databases.map((d) => ({
      id: d.id,
      kind: "database" as const,
      name: d.name,
      logo: d.logo,
      logoTone: null,
      engine: d.engine,
      teamName: d.teamName,
      href: page(d.teamId, d.teamSlug, `/storage/databases/${d.id}`),
      project: d.project,
      environment: d.environment,
      domain: null,
      ...live(
        d.id,
        DATABASE_STATUS[d.status as DatabaseStatus] ?? "error",
        false,
      ),
    })),
  ];
  return rows.sort(
    (a, b) =>
      a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name),
  );
}
