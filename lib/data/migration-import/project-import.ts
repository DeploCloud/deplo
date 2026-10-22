import "server-only";

import { blocker, type Note } from "../../migration/note";
import { errorMessage } from "../../utils";
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
import {
  createEnvironment,
  listEnvironmentsForProject,
  setDefaultEnvironment,
} from "../environments";
import { createProject } from "../projects/lifecycle";
import { listProjects } from "../projects/read";
import { canHostWorkloads, listServersForTeam } from "../servers/roster";
import { recordActivity } from "../activity";
import { runAsMigration } from "../migration-guard";
import { assertImportGate, credentialFor, type ConnectInput } from "./gates";
import {
  Report,
  countOutcomes,
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
  blocking: number;
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

  const landing = await ensureProject(source, report);
  if (!landing)
    return {
      projectName: source.name,
      ...countOutcomes(report.items),
      items: report.items,
    };
  const projectId = landing.projectId;

  const destinations = await importBackupDestinations(c, report);

  const wanted = input.serviceIds ? new Set(input.serviceIds) : null;
  const picked = (env: SourceEnvironment) =>
    servicesOf(env).filter((s) => !wanted || wanted.has(s.id));

  const shared: SharedIndex = new Map();
  const createdVars = new Set<string>();
  await noteLevel(report, source.platformNotes);
  try {
    const team = await sourceClient(c).teamSharedEnv();
    await importSharedVars(
      team,
      {
        secretKeys: team?.secretEnvKeys,
        teamId,
        label: "Team",
        level: "team",
        created: createdVars,
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
    source,
    {
      secretKeys: source.secretEnvKeys,
      teamId,
      label: source.name,
      level: "project",
      created: createdVars,
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
        machine,
        {
          secretKeys: machine?.secretEnvKeys,
          teamId,
          label: `${source.name} (server)`,
          level: "server",
          created: createdVars,
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
    // An environment empty on the source still comes across; one whose services were all left out does not.
    if (chosen.length === 0 && servicesOf(env).length > 0) continue;

    const envReport = report.at(env.name);
    const environmentId = await ensureEnvironment(landing, env, envReport);
    if (!environmentId) {
      for (const svc of chosen)
        await envReport.at(svc.name || svc.id).add({
          sourceKind: svc.kind,
          sourceId: svc.id,
          sourceName: svc.name || svc.id,
          outcome: "failed",
          targetKind:
            svc.kind === "application" || svc.kind === "compose"
              ? "app"
              : "database",
          message: `${svc.name || svc.id} did not come across: its environment ${env.name} could not be created. Create it in the project, then run the migration again.`,
        });
      continue;
    }
    await noteLevel(envReport, env.platformNotes);

    // Each environment sees its own variables, never a sibling's of the same name.
    const envShared: SharedIndex = new Map(shared);
    const envLevel =
      env.env != null
        ? env
        : await sourceClient(c).getEnvironment(env.environmentId);
    await importSharedVars(
      envLevel,
      {
        secretKeys: envLevel?.secretEnvKeys,
        teamId,
        label: `${source.name} / ${env.name}`,
        level: "environment",
        created: createdVars,
        environmentIds: [environmentId],
        projectIds: [],
        scopeNote: `Offered to ${env.name}.`,
        report: envReport,
      },
      envShared,
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
              shared: envShared,
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

  await finishEnvironments(landing, source.environments ?? []);
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
    ...countOutcomes(report.items),
    items: report.items,
  };
}

// A project this run created is shaped like the source's; one already here is left as it is.
interface ProjectLanding {
  projectId: string;
  fresh: boolean;
  landed: Map<string, string>;
}

async function ensureProject(
  source: SourceProject,
  report: Report,
): Promise<ProjectLanding | null> {
  const key = source.name.trim().toLowerCase();
  for (const p of await listProjects())
    if (p.name.trim().toLowerCase() === key) {
      await report.add({
        sourceKind: "project",
        sourceId: source.projectId,
        sourceName: source.name,
        outcome: "skipped",
        targetKind: "project",
        targetId: p.id,
        message: "A project with this name is already here.",
      });
      return { projectId: p.id, fresh: false, landed: new Map() };
    }
  try {
    const created = await createProject(source.name);
    await report.add({
      sourceKind: "project",
      sourceId: source.projectId,
      sourceName: source.name,
      outcome: "created",
      targetKind: "project",
      targetId: created.id,
    });
    return { projectId: created.id, fresh: true, landed: new Map() };
  } catch (e) {
    await report.add({
      sourceKind: "project",
      sourceId: source.projectId,
      sourceName: source.name,
      outcome: "failed",
      targetKind: "project",
      message: e instanceof Error ? e.message : "Could not create the project.",
    });
    return null;
  }
}

async function ensureEnvironment(
  landing: ProjectLanding,
  env: SourceEnvironment,
  report: Report,
): Promise<string | null> {
  const id = await landEnvironment(landing, env, report);
  if (id) landing.landed.set(env.environmentId, id);
  return id;
}

async function landEnvironment(
  { projectId, landed }: ProjectLanding,
  env: SourceEnvironment,
  report: Report,
): Promise<string | null> {
  const key = env.name.trim().toLowerCase();
  const existing = await listEnvironmentsForProject(projectId);
  const taken = new Set(landed.values());
  const same = existing.find(
    (e) => !taken.has(e.id) && e.name.trim().toLowerCase() === key,
  );
  try {
    if (same) {
      await report.add({
        sourceKind: "environment",
        sourceId: env.environmentId,
        sourceName: env.name,
        outcome: "skipped",
        targetKind: "environment",
        targetId: same.id,
        message: "This environment already exists in the project.",
      });
      return same.id;
    }
    const id = (await createEnvironment(projectId, env.name)).id;
    await report.add({
      sourceKind: "environment",
      sourceId: env.environmentId,
      sourceName: env.name,
      outcome: "created",
      targetKind: "environment",
      targetId: id,
    });
    return id;
  } catch (e) {
    await report.add({
      sourceKind: "environment",
      sourceId: env.environmentId,
      sourceName: env.name,
      outcome: "failed",
      targetKind: "environment",
      message: `${env.name} could not be created: ${errorMessage(
        e,
        "Deplo refused it.",
      )}`,
    });
    return null;
  }
}

// On a project this run created: the source's default environment is the default here too.
async function finishEnvironments(
  { fresh, landed }: ProjectLanding,
  envs: SourceEnvironment[],
): Promise<void> {
  if (!fresh) return;
  const def = envs.find((e) => e.isDefault);
  const target = def && landed.get(def.environmentId);
  if (target) await setDefaultEnvironment(target);
}

async function noteLevel(
  report: Report,
  notes: Note[] | null | undefined,
): Promise<void> {
  await report.notes("shared-var", "Shared variables", notes ?? [], {
    kind: "shared-var",
  });
}

async function levelRefused(
  report: Report,
  level: "team" | "server",
  name: string,
  e: unknown,
): Promise<void> {
  const why = errorMessage(e, "it refused the request");
  await report.notes(
    "shared-var",
    level === "team" ? "Team" : name || "Server",
    [
      blocker(
        `{panel} would not answer for the ${level} shared variables (${why}). None of them came across - copy them in under Variables.`,
      ),
    ],
    { kind: "shared-var" },
  );
}
