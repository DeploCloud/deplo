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
  // The source `projectId` to import.
  projectId: string;
  // Source server id (or "") to Deplo server id. Unmapped falls back to default.
  servers?: ServerChoice[];
  // The source service ids to import, out of the project's own. Absent imports
  // everything, so a client that cannot express a selection still gets the whole project.
  serviceIds?: string[];
  // Where each service lands, by its source id. A service with no entry falls back to
  // `servers`, the per-HOST mapping, so a caller that cannot place one is unaffected.
  placements?: ServicePlacement[];
}

// importMigrationProject - import ONE source project into the active team. The source
// is re-read here rather than taken from the scan: app configuration must never arrive
// from a browser. `runAsMigration` exempts the run's own writes from the marker it sets.
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
  // Per SERVICE, and it wins over the per-host mapping: the review screen places
  // apps one by one, and the host mapping is what a caller falls back to.
  const placed = await resolvePlacements(
    teamId,
    input.placements ?? [],
    report,
    source.name,
  );

  // Read ONCE, up here: without the grant a database's port cannot be published at all,
  // and knowing that BEFORE the create is what lets the report say the true reason.
  const mayExposePorts = await canExposePorts();

  // Which of OUR servers each source machine IS, as an address match rather than the
  // caller's `servers` mapping: that one falls back to the Deplo host, the right default
  // for "where does this land" and the wrong answer to "is this the same box".
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

  // Where a service lands when nobody named a host.
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

  // What a database was called on the other side, and what it answers to here: filled in
  // as the databases land, which is why they are imported first, and kept with the RUN so
  // an app in a later project sees the databases of an earlier one.
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

  // Before the databases: a schedule can only be set on a database whose
  // destination is already here.
  const destinations = await importBackupDestinations(c, report);

  // What the caller picked, or everything. A service left out is left out SILENTLY: it
  // is a choice made on the review screen, and a line per unticked box would bury the
  // ones that need reading.
  const wanted = input.serviceIds ? new Set(input.serviceIds) : null;
  const picked = (env: SourceEnvironment) =>
    servicesOf(env).filter((s) => !wanted || wanted.has(s.id));

  // The shared variables come FIRST, because a link needs the row it points at.
  // Levels in reach order: team, project, then each machine that hosts something
  // we are importing.
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
  // Coolify's fourth level has no twin here: a variable scoped to a MACHINE
  // covers everything on it, across projects. Offered to this project instead.
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
      // Databases first: an app's connection strings still spell the hostname the
      // database had over there, and rewriting them needs the new one to exist.
      .sort(
        (a, b) =>
          Number(a.kind === "application" || a.kind === "compose") -
          Number(b.kind === "application" || b.kind === "compose"),
      );
    // An environment nobody picked anything from is not created empty.
    if (chosen.length === 0) continue;

    const envReport = report.at(env.name);
    const environmentId = await ensureEnvironment(projectId, env, envReport);
    if (!environmentId) continue;
    await noteLevel(envReport, env.platformNotes);

    // BEFORE the services: `project.all` is a projection, so an environment's
    // variable blob is ALWAYS null there however much it holds.
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

    // Apps landed in this environment.
    const appIds: string[] = [];

    for (const svc of chosen) {
      const isApp = svc.kind === "application" || svc.kind === "compose";
      const targetKind = isApp ? "app" : "database";

      // An engine Deplo does not have is settled without importing anything,
      // but under its own name, not its id (see the scan for why).
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
      // The DETAIL is loaded here rather than inside each importer because it is also
      // where the service's real name lives: the tree gives a database nothing but its id,
      // so a report scoped before this call has an empty breadcrumb for the hardest rows.
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

      // The MACHINE, from the row that has one: `project.all` carries no server, so
      // every service on the second host mapped as if it were on the panel's own.
      const sourceServerId = detail.serverId?.trim() || svc.serverId;

      // Deplo caps a name at 60 characters; the panel's display NAME is free text, and a
      // service called after a team, a region and a cluster goes past it.
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
              // The port the review settled on, or the source's own when it said
              // nothing. `null` is a decision ("publish nothing"), not a silence.
              exposedPort: placement?.exposedPort,
              mayExposePorts,
              // Whether the machine it runs on over there IS the one it is about to run on
              // here: the one case where the port it wants is held by the container we are
              // importing, and stopping that frees it.
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
  // Outside every transaction, like every other caller: `recordActivity` opens its
  // own connection and would deadlock pglite from inside one.
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
    // Same fold as `refreshCounts`: an engine with no equivalent here is a
    // decision for a person, and every item belongs to exactly one total.
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

// The Deplo Environment for a source one.
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
    // A name Deplo reserves (`pr-<n>`) or a duplicate: fall back to the project's
    // default environment so the services still land somewhere sensible.
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

// The adapter's own notes for one level of the tree, straight onto the report.
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

// A shared-variable level the panel would not answer for. `manual`, not `failed`: an
// older build simply has no such endpoint, and `manual` already means "a person has to
// look at this".
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
