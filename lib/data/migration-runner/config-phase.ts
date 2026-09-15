import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  migrationRuns as runsTable,
  migrationRunServers as runServersTable,
  migrationRunTargets as targetsTable,
} from "../../db/schema/control-plane/migration";
import { sourceClient } from "../../migration/source";
import { credentialFor as connectCredential } from "../migration-import/gates";
import { importMigrationProject } from "../migration-import/project-import";
import { appendRunItem } from "../migration-import/run-report";
import type { ServicePlacement } from "../migration-import/target-servers";
import { checkServerHealth } from "../server-health";
import { listServersForTeam } from "../servers/roster";
import { beat, setProgress } from "./heartbeat";
import type { RunCredential, RunRow } from "./runner-state";
import { panelNameFor } from "./runner-state";
import { stopped } from "./stop";

async function assertMachinesAnswer(row: RunRow): Promise<void> {
  const ids = new Set(
    (
      await getDb()
        .select({ to: runServersTable.toId })
        .from(runServersTable)
        .where(eq(runServersTable.runId, row.id))
    ).map((r) => r.to),
  );
  if (ids.size === 0) return;
  const known = new Map(
    (await listServersForTeam(row.teamId)).map((s) => [s.id, s.name]),
  );
  for (const id of ids) {
    const server = await checkServerHealth(id, { force: true });
    if (server.status !== "online")
      throw new Error(
        `${known.get(id) ?? "A machine"} is not answering: ${
          server.statusMessage || "no answer"
        }. Nothing was created.`,
      );
  }
}

interface ProjectGroup {
  projectId: string;
  projectName: string;
  rowIds: string[];
  serviceIds: string[];
  placements: ServicePlacement[];
}

async function noteEmptyProjects(row: RunRow, c: RunCredential): Promise<void> {
  let projects;
  try {
    projects = await sourceClient(await connectCredential(c)).listProjects();
  } catch {
    return;
  }
  for (const p of projects) {
    const holds = (e: {
      applications?: unknown[] | null;
      compose?: unknown[] | null;
      postgres?: unknown[] | null;
      mysql?: unknown[] | null;
      mariadb?: unknown[] | null;
      mongo?: unknown[] | null;
      redis?: unknown[] | null;
      libsql?: unknown[] | null;
      clickhouse?: unknown[] | null;
    }) =>
      [
        e.applications,
        e.compose,
        e.postgres,
        e.mysql,
        e.mariadb,
        e.mongo,
        e.redis,
        e.libsql,
        e.clickhouse,
      ].some((l) => (l ?? []).length > 0);
    if ((p.environments ?? []).some(holds) || holds(p)) continue;
    await appendRunItem(row.id, panelNameFor(row), {
      path: p.name,
      sourceKind: "project",
      sourceName: p.name,
      sourceId: p.projectId,
      outcome: "skipped",
      message:
        "Nothing is in this project on {panel}, so there was nothing to bring across.",
    });
  }
}

async function pendingGroups(runId: string): Promise<ProjectGroup[]> {
  const rows = await getDb()
    .select()
    .from(targetsTable)
    .where(
      and(eq(targetsTable.runId, runId), eq(targetsTable.state, "pending")),
    )
    .orderBy(asc(targetsTable.seq));
  const byProject = new Map<string, ProjectGroup>();
  for (const r of rows) {
    let g = byProject.get(r.projectId);
    if (!g) {
      g = {
        projectId: r.projectId,
        projectName: r.projectName,
        rowIds: [],
        serviceIds: [],
        placements: [],
      };
      byProject.set(r.projectId, g);
    }
    g.rowIds.push(r.id);
    g.serviceIds.push(r.serviceId);
    if (r.serverId)
      g.placements.push({
        serviceId: r.serviceId,
        serverId: r.serverId,
        buildServerId: r.buildServerId,
        ...(r.exposedPortSet ? { exposedPort: r.exposedPort } : {}),
      });
  }
  return [...byProject.values()];
}

async function markTargets(ids: string[], state: string): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .update(targetsTable)
    .set({ state })
    .where(sql`${targetsTable.id} in ${ids}`);
}

export async function runConfigPhase(
  row: RunRow,
  c: RunCredential,
): Promise<void> {
  await assertMachinesAnswer(row);

  const servers = (
    await getDb()
      .select()
      .from(runServersTable)
      .where(eq(runServersTable.runId, row.id))
  ).map((r) => ({ from: r.fromId, to: r.toId }));

  let inARow = 0;
  let done = row.doneSteps;

  await noteEmptyProjects(row, c);
  await appendRunItem(row.id, panelNameFor(row), {
    path: "{panel}",
    sourceKind: "organization",
    sourceName: row.orgName || "{panel}",
    outcome: "skipped",
    message:
      "An API key belongs to one organization, so this import covers that one only. Anything under another organization on {panel} needs a second import with a key from it.",
  });

  for (const g of await pendingGroups(row.id)) {
    if (await stopped(row.id)) return;
    await beat(row.id);
    await setProgress(row.id, { stepLabel: g.projectName });
    try {
      await importMigrationProject({
        url: c.url,
        apiKey: c.apiKey,
        kind: c.kind,
        runId: row.id,
        projectId: g.projectId,
        servers,
        serviceIds: g.serviceIds,
        placements: g.placements,
      });
      await markTargets(g.rowIds, "done");
      inARow = 0;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await markTargets(g.rowIds, "failed");
      await appendRunItem(row.id, panelNameFor(row), {
        path: g.projectName,
        sourceKind: "project",
        sourceName: g.projectName,
        outcome: "failed",
        message: why,
      });
      if (++inARow >= 2)
        throw new Error(
          `Two projects in a row failed the same way, so Deplo stopped. Last error: ${why}`,
        );
    }
    done += g.rowIds.length;
    await setProgress(row.id, { doneSteps: done });
  }

  if (await stopped(row.id)) return;

  const [after] = await getDb()
    .select({ created: runsTable.created, skipped: runsTable.skipped })
    .from(runsTable)
    .where(eq(runsTable.id, row.id))
    .limit(1);
  if ((after?.created ?? 0) === 0 && (after?.skipped ?? 0) === 0)
    throw new Error(
      "Nothing came across, so Deplo stopped before touching any data. The report says what refused.",
    );

  if (await stopped(row.id)) return;
  await setProgress(row.id, {
    phase: "data",
    doneSteps: 0,
    stepLabel: "Reading the volumes",
  });
}
