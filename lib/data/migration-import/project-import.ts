import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { migrationRunDbHosts as dbHostsTable } from "../../db/schema/control-plane/migration";
import { getCurrentUser } from "../../auth/current-user";
import { canExposePorts } from "../../membership";
import { sourceClient } from "../../migration/source";
import type { SourceDbKind } from "../../migration/model";
import type {
  SourceApplication,
  SourceCompose,
  SourceDatabase,
  SourceEnvironment,
  SourceProject,
} from "../../migration/model";
import { deploEngineFor } from "../../migration/map/databases";
import { createEnvironment, listEnvironmentsForProject } from "../environments";
import { createProject } from "../projects/lifecycle";
import { defaultEnvironmentFor } from "../projects/placement";
import { listProjects } from "../projects/read";
import { canHostWorkloads, listServersForTeam } from "../servers/roster";
import { recordActivity } from "../activity";
import { runAsMigration } from "../migration-guard";
import { assertImportGate, credentialFor, type ConnectInput } from "./gates";
import {
  Report,
  ownRun,
  refreshCounts,
  type ImportItemDTO,
} from "./run-report";
import {
  loadService,
  nameOf,
  nameOfService,
  servicesOf,
  truncateName,
} from "./source-tree";
import { migrationMachines } from "./source-machines";
import {
  resolvePlacements,
  resolveServers,
  type ServerChoice,
  type ServicePlacement,
} from "./target-servers";
import { importSharedVars, type SharedIndex } from "./shared-vars-import";
import { importBackupDestinations } from "./source-backups";
import { importAppService } from "./app-import";
import { importDatabaseService } from "./database-import";

export interface ImportProjectResult {
  projectName: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  items: ImportItemDTO[];
}

export interface ImportProjectInput extends ConnectInput {
  runId: string;
  projectId: string;
  servers?: ServerChoice[];
  serviceIds?: string[];
  placements?: ServicePlacement[];
}

export async function importMigrationProject(
  input: ImportProjectInput,
): Promise<ImportProjectResult> {
  return runAsMigration(() => runImportMigrationProject(input));
}

async function runImportMigrationProject(
  input: ImportProjectInput,
): Promise<ImportProjectResult> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const projects = await sourceClient(c).listProjects();
  const source = projects.find((p) => p.projectId === input.projectId);
  if (!source)
    throw new Error("That project is no longer on the source instance.");

  const report = new Report(input.runId, sourceClient(c).displayName).at(
    source.name,
  );
  const serverMap = await resolveServers(
    teamId,
    input.servers ?? [],
    report,
    source.name,
  );
  const placed = await resolvePlacements(
    teamId,
    input.placements ?? [],
    report,
    source.name,
  );

  const mayExposePorts = await canExposePorts();

  let machineHosts: Map<string, string | null> | null = null;
  const hostOfMachine = async (sourceServerId: string) => {
    if (!machineHosts)
      machineHosts = new Map(
        (await migrationMachines(c, teamId)).map((m) => [
          m.sourceId,
          m.deploServerId,
        ]),
      );
    return machineHosts.get(sourceServerId) ?? null;
  };

  let soleServer: string | null | undefined;
  const targetServerFor = async (given: string | undefined) => {
    if (given) return given;
    if (soleServer === undefined) {
      const usable = (await listServersForTeam(teamId)).filter(
        canHostWorkloads,
      );
      soleServer = usable.length === 1 ? usable[0].id : null;
    }
    return soleServer ?? undefined;
  };

  const dbHosts = new Map<string, string>();
  if (report.id)
    for (const h of await getDb()
      .select({ from: dbHostsTable.sourceHost, to: dbHostsTable.targetHost })
      .from(dbHostsTable)
      .where(eq(dbHostsTable.runId, report.id)))
      dbHosts.set(h.from, h.to);

  const projectId = await ensureProject(source, report);
  if (!projectId)
    return {
      projectName: source.name,
      ...tally(report.items),
      items: report.items,
    };

  const destinations = await importBackupDestinations(c, report);

  const wanted = input.serviceIds ? new Set(input.serviceIds) : null;
  const picked = (env: SourceEnvironment) =>
    servicesOf(env).filter((s) => !wanted || wanted.has(s.id));

  const shared: SharedIndex = new Map();
  await noteLevel(report, source.platformNotes);
  try {
    const team = await sourceClient(c).teamSharedEnv();
    await importSharedVars(
      team?.env ?? null,
      {
        secretKeys: team?.secretEnvKeys,
        teamId,
        label: "Team",
        environmentIds: [],
        projectIds: [],
        teamWide: true,
        scopeNote: "Offered to your whole team.",
        report,
      },
      shared,
    );
  } catch (e) {
    await levelRefused(report, "team", "", e);
  }
  await importSharedVars(
    source.env,
    {
      secretKeys: source.secretEnvKeys,
      teamId,
      label: source.name,
      environmentIds: [],
      projectIds: [projectId],
      scopeNote: "Offered to this project.",
      report,
    },
    shared,
  );
  for (const sourceServerId of new Set(
    (source.environments ?? []).flatMap((env) =>
      picked(env).map((s) => s.serverId ?? ""),
    ),
  )) {
    try {
      const machine = await sourceClient(c).serverSharedEnv(sourceServerId);
      await importSharedVars(
        machine?.env ?? null,
        {
          secretKeys: machine?.secretEnvKeys,
          teamId,
          label: `${source.name} (server)`,
          environmentIds: [],
          projectIds: [projectId],
          scopeNote:
            "{panel} shared this across everything on one machine. Deplo has no server scope, so it is offered to this project instead.",
          report,
        },
        shared,
      );
    } catch (e) {
      await levelRefused(report, "server", sourceServerId, e);
    }
  }

  for (const env of source.environments ?? []) {
    const chosen = servicesOf(env)
      .filter((s) => !wanted || wanted.has(s.id))
      .sort(
        (a, b) =>
          Number(a.kind === "application" || a.kind === "compose") -
          Number(b.kind === "application" || b.kind === "compose"),
      );
    if (chosen.length === 0) continue;

    const envReport = report.at(env.name);
    const environmentId = await ensureEnvironment(projectId, env, envReport);
    if (!environmentId) continue;
    await noteLevel(envReport, env.platformNotes);

    const envLevel =
      env.env != null
        ? env
        : await sourceClient(c).getEnvironment(env.environmentId);
    await importSharedVars(
      envLevel?.env ?? null,
      {
        secretKeys: envLevel?.secretEnvKeys,
        teamId,
        label: `${source.name} / ${env.name}`,
        environmentIds: [environmentId],
        projectIds: [],
        scopeNote: `Offered to ${env.name}.`,
        report: envReport,
      },
      shared,
    );

    const appIds: string[] = [];

    for (const svc of chosen) {
      const isApp = svc.kind === "application" || svc.kind === "compose";
      const targetKind = isApp ? "app" : "database";

      if (!isApp && !deploEngineFor(svc.kind as SourceDbKind)) {
        const unsupportedName = await nameOfService(c, svc);
        await envReport.at(unsupportedName).add({
          sourceKind: svc.kind,
          sourceId: svc.id,
          sourceName: unsupportedName,
          outcome: "unsupported",
          targetKind,
          message: `Deplo has no ${svc.kind} engine.`,
        });
        continue;
      }
      let detail: SourceApplication | SourceCompose | SourceDatabase;
      try {
        detail = await loadService(c, svc);
      } catch (e) {
        await envReport.at(svc.name || svc.id).add({
          sourceKind: svc.kind,
          sourceId: svc.id,
          sourceName: svc.name || svc.id,
          outcome: "failed",
          targetKind,
          message:
            e instanceof Error ? e.message : "{panel} would not return it.",
        });
        continue;
      }

      const sourceServerId = detail.serverId?.trim() || svc.serverId;

      const fullName = nameOf(detail, svc);
      const name = truncateName(fullName);
      const svcReport = envReport.at(name);
      if (name !== fullName)
        await svcReport.add({
          sourceKind: svc.kind,
          sourceId: svc.id,
          sourceName: name,
          outcome: "manual",
          targetKind,
          message: `Its name is longer than Deplo allows, so it came across as "${name}". Rename it under Settings.`,
        });

      try {
        if (isApp) {
          const appId = await importAppService(
            c,
            svc,
            detail as SourceApplication & SourceCompose,
            name,
            {
              projectId,
              environmentId,
              serverId:
                placed.get(svc.id)?.serverId ?? serverMap.get(sourceServerId),
              buildServerId: placed.get(svc.id)?.buildServerId ?? null,
              sourceHost: await hostOfMachine(sourceServerId),
              dbHosts,
              shared,
              destinations,
            },
            svcReport,
          );
          if (appId) appIds.push(appId);
        } else {
          const placement = placed.get(svc.id);
          const serverId = await targetServerFor(
            placement?.serverId ?? serverMap.get(sourceServerId),
          );
          await importDatabaseService(
            c,
            svc,
            detail as SourceDatabase,
            name,
            {
              serverId,
              projectName: source.name,
              environmentId,
              exposedPort: placement?.exposedPort,
              mayExposePorts,
              sourceIsTargetHost:
                serverId != null &&
                (await hostOfMachine(sourceServerId)) === serverId,
              dbHosts,
              destinations,
            },
            svcReport,
          );
        }
      } catch (e) {
        await svcReport.add({
          sourceKind: svc.kind,
          sourceId: svc.id,
          sourceName: name,
          outcome: "failed",
          targetKind,
          message: e instanceof Error ? e.message : "Import failed.",
        });
      }
    }
  }

  await refreshCounts(input.runId, teamId);
  await recordActivity(
    "project",
    `Imported ${source.name} from ${sourceClient(c).displayName}`,
    (await getCurrentUser())?.name ?? "someone",
    null,
    teamId,
  );

  return {
    projectName: source.name,
    ...tally(report.items),
    items: report.items,
  };
}

function tally(items: ImportItemDTO[]): {
  created: number;
  skipped: number;
  failed: number;
  manual: number;
} {
  const n = (o: string) => items.filter((i) => i.outcome === o).length;
  return {
    created: n("created"),
    skipped: n("skipped"),
    failed: n("failed"),
    manual: n("manual") + n("unsupported"),
  };
}

async function ensureProject(
  source: SourceProject,
  report: Report,
): Promise<string | null> {
  const key = source.name.trim().toLowerCase();
  for (const p of await listProjects())
    if (p.name.trim().toLowerCase() === key) {
      await report.add({
        sourceKind: "project",
        sourceName: source.name,
        outcome: "skipped",
        targetKind: "project",
        targetId: p.id,
        message: "A project with this name is already here.",
      });
      return p.id;
    }
  try {
    const created = await createProject(source.name);
    await report.add({
      sourceKind: "project",
      sourceName: source.name,
      outcome: "created",
      targetKind: "project",
      targetId: created.id,
    });
    return created.id;
  } catch (e) {
    await report.add({
      sourceKind: "project",
      sourceName: source.name,
      outcome: "failed",
      targetKind: "project",
      message: e instanceof Error ? e.message : "Could not create the project.",
    });
    return null;
  }
}

async function ensureEnvironment(
  projectId: string,
  env: SourceEnvironment,
  report: Report,
): Promise<string | null> {
  const key = env.name.trim().toLowerCase();
  for (const e of await listEnvironmentsForProject(projectId))
    if (e.name.trim().toLowerCase() === key) {
      await report.add({
        sourceKind: "environment",
        sourceName: env.name,
        outcome: "skipped",
        targetKind: "environment",
        targetId: e.id,
        message: "This environment already exists in the project.",
      });
      return e.id;
    }
  try {
    const created = await createEnvironment(projectId, env.name);
    await report.add({
      sourceKind: "environment",
      sourceName: env.name,
      outcome: "created",
      targetKind: "environment",
      targetId: created.id,
    });
    return created.id;
  } catch (e) {
    const fallback = await defaultEnvironmentFor(projectId);
    await report.add({
      sourceKind: "environment",
      sourceName: env.name,
      outcome: fallback ? "manual" : "failed",
      targetKind: "environment",
      targetId: fallback?.id ?? null,
      message:
        (e instanceof Error ? e.message : "Could not create the environment.") +
        (fallback ? ` Its services went to ${fallback.name} instead.` : ""),
    });
    return fallback?.id ?? null;
  }
}

async function noteLevel(
  report: Report,
  notes: string[] | null | undefined,
): Promise<void> {
  for (const message of notes ?? [])
    await report.add({
      sourceKind: "shared-var",
      sourceName: "Shared variables",
      outcome: "manual",
      targetKind: "shared-var",
      message,
    });
}

async function levelRefused(
  report: Report,
  level: "team" | "server",
  name: string,
  e: unknown,
): Promise<void> {
  const why = e instanceof Error ? e.message : "it refused the request";
  await report.add({
    sourceKind: "shared-var",
    sourceName: level === "team" ? "Team" : name || "Server",
    outcome: "manual",
    targetKind: "shared-var",
    message: `{panel} would not answer for the ${level} shared variables (${why}). None of them came across - copy them in under Variables.`,
  });
}
