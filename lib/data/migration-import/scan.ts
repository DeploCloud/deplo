import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { mapLimit } from "../../utils";
import { canExposePorts, canMountHostVolumes } from "../../membership";
import { sourceClient } from "../../migration/source";
import type { MigrationPlatform } from "../../migration/source";
import { type SourceDbKind } from "../../migration/model";
import type {
  SourceApplication,
  SourceCompose,
  SourceDatabase,
} from "../../migration/model";
import {
  mapBuildSettings,
  mapLogo,
  mapPorts,
  unsupportedNotes,
} from "../../migration/map/app-settings";
import { mapSource } from "../../migration/map/app-source";
import { adaptComposeForDeplo } from "../../migration/map/compose-adapt";
import { deploEngineFor, mapDatabase } from "../../migration/map/databases";
import { mapDomains } from "../../migration/map/domains";
import { envNeedsInterpolation, parseEnvBlob } from "../../migration/map/env";
import { withPanel } from "../../migration/map/source-platform";
import { listEnvironmentsForProject } from "../environments";
import { listProjects } from "../projects/read";
import {
  assertImportGate,
  assertPanelReadGate,
  credentialFor,
  type ConnectInput,
} from "./gates";
import {
  composeAdvice,
  composeBlockers,
  composePlatform,
} from "./compose-notes";
import { loadService, nameOf, nameOfService, servicesOf } from "./source-tree";
import { adoptMigrationSources } from "./source-agents";
import {
  planMachines,
  rememberedAddresses,
  type PlanServer,
} from "./source-machines";
import { planMembers, type PlanMember } from "./source-people";

export type PlanStatus = "new" | "exists" | "unsupported" | "needs_grant";

export interface PlanService {
  sourceId: string;
  kind: string;
  name: string;
  targetKind: string | null;
  status: PlanStatus;
  sourceServerId: string;
  buildsFromSource: boolean;
  engine: string | null;
  exposedPort: number | null;
  domains: string[];
  logo: string | null;
  notes: string[];
}

export interface PlanEnvironment {
  sourceId: string;
  name: string;
  exists: boolean;
  services: PlanService[];
}

export interface PlanProject {
  sourceId: string;
  name: string;
  exists: boolean;
  environments: PlanEnvironment[];
}

export interface MigrationPlan {
  platform: MigrationPlatform;
  sourceUrl: string;
  orgName: string | null;
  otherTeams: string[] | null;
  projects: PlanProject[];
  servers: PlanServer[];
  members: PlanMember[];
}

export interface SourceIdentity {
  platform: MigrationPlatform;
  teamId: string | null;
  teamName: string | null;
  otherTeams: string[] | null;
}

export async function identifyMigrationSource(
  input: ConnectInput,
): Promise<SourceIdentity> {
  await assertPanelReadGate();
  const c = await credentialFor(input);
  await sourceClient(c).assertReadable();
  const [team, others] = await Promise.all([
    sourceClient(c).sourceTeam(),
    sourceClient(c).otherTeams(),
  ]);
  return {
    platform: c.kind,
    teamId: team.id,
    teamName: team.name,
    otherTeams: others,
  };
}

export async function scanMigrationSource(
  input: ConnectInput,
  opts: { newTeam?: boolean } = {},
): Promise<MigrationPlan> {
  const { teamId } = opts.newTeam
    ? await assertPanelReadGate()
    : await assertImportGate();
  const c = await credentialFor(input);
  await sourceClient(c).assertReadable();

  const [sourceTeam, otherTeams, servers, projects] = await Promise.all([
    sourceClient(c).sourceTeam(),
    sourceClient(c).otherTeams(),
    sourceClient(c)
      .listServers()
      .catch(() => []),
    sourceClient(c).listProjects(),
  ]);

  if (!opts.newTeam)
    await adoptMigrationSources(
      teamId,
      new Set(
        [
          new URL(c.baseUrl).hostname,
          ...servers.map((s) => s.ipAddress),
          ...(await rememberedAddresses(teamId, c.baseUrl)).values(),
        ]
          .map((a) => a?.trim().toLowerCase() ?? "")
          .filter(Boolean),
      ),
    );

  const existing = opts.newTeam ? nothingHere() : await existingNames(teamId);
  const mayMountHost = await canMountHostVolumes();
  const mayExposePorts = await canExposePorts();
  const foreignHosts = await hostnamesOwnedElsewhere(
    opts.newTeam ? null : teamId,
  );

  let machineIds: Map<string, string | null> | null = null;
  const machineServer = async (sourceServerId: string) => {
    if (!machineIds)
      machineIds = new Map(
        (await planMachines(c, teamId, servers)).map((m) => [
          m.sourceId,
          m.deploServerId,
        ]),
      );
    return machineIds.get(sourceServerId) ?? null;
  };

  const planned: PlanProject[] = [];
  for (const p of projects) {
    const projectKey = p.name.trim().toLowerCase();
    const existingProject = existing.projects.get(projectKey) ?? null;
    const environments: PlanEnvironment[] = [];

    for (const env of p.environments ?? []) {
      const envKey = env.name.trim().toLowerCase();
      const existingEnv = existingProject
        ? (existing.environments.get(`${existingProject}:${envKey}`) ?? null)
        : null;

      const list = servicesOf(env);
      const services: PlanService[] = new Array(list.length);
      await mapLimit(
        list.map((svc, index) => ({ svc, index })),
        5,
        async ({ svc, index }) => {
          const line: PlanService = {
            sourceId: svc.id,
            kind: svc.kind,
            name: svc.name || svc.id,
            targetKind:
              svc.kind === "compose" || svc.kind === "application"
                ? "app"
                : deploEngineFor(svc.kind)
                  ? "database"
                  : null,
            status: "new",
            sourceServerId: svc.serverId,
            buildsFromSource: false,
            engine: deploEngineFor(svc.kind as SourceDbKind),
            exposedPort: null,
            domains: [],
            logo: null,
            notes: [],
          };
          if (line.targetKind === null) {
            line.status = "unsupported";
            line.name = await nameOfService(c, svc);
            line.notes.push(`Deplo has no ${svc.kind} engine.`);
            services[index] = line;
            return;
          }

          let detail: SourceApplication | SourceCompose | SourceDatabase;
          try {
            detail = await loadService(c, svc);
          } catch (e) {
            line.status = "unsupported";
            line.notes.push(
              e instanceof Error
                ? e.message
                : "{panel} would not return this service.",
            );
            services[index] = line;
            return;
          }

          line.name = nameOf(detail, svc);
          line.sourceServerId = detail.serverId?.trim() || line.sourceServerId;
          line.logo = mapLogo((detail as SourceApplication).icon);
          line.notes.push(
            ...((detail as SourceApplication).platformNotes ?? []),
          );

          if (line.targetKind === "database") {
            const key = line.name.trim().toLowerCase();
            if (existing.databases.has(key)) line.status = "exists";
            const mappedDb = mapDatabase(svc.kind as SourceDbKind, {
              ...(detail as SourceDatabase),
              name: line.name,
            });
            line.exposedPort = mappedDb.value?.exposedPort ?? null;
            line.notes.push(...mappedDb.notes);
            services[index] = line;
            return;
          }

          const homeKey = existingEnv
            ? `${existingEnv}:${line.name.trim().toLowerCase()}`
            : null;
          if (homeKey && existing.apps.has(homeKey)) line.status = "exists";

          const isCompose = svc.kind === "compose";
          const scanned = parseEnvBlob((detail as SourceApplication).env);
          const scannedRefs = (detail as SourceApplication).sharedRefs ?? [];
          const willLink = scannedRefs
            .filter((r) => r.whole && r.key === r.sharedKey)
            .map((r) => r.key);
          if (willLink.length > 0)
            line.notes.push(
              `${willLink.join(", ")} read a shared variable on {panel}, so ${
                willLink.length === 1
                  ? "it becomes a link"
                  : "they become links"
              } to the shared variable of the same name here.`,
            );
          const refKeys = new Set(scannedRefs.map((r) => r.key));
          const templated = envNeedsInterpolation(scanned).filter(
            (k) => !refKeys.has(k),
          );
          if (templated.length > 0)
            line.notes.push(
              `Deplo does not resolve {panel}'s \`\${{...}}\` templating - these arrive as they are written: ${templated.join(", ")}.`,
            );
          const domains = mapDomains((detail as SourceApplication).domains, {
            isCompose,
            fallbackPort: (detail as SourceApplication).routingPort,
            compose: isCompose
              ? ((detail as SourceCompose).composeFile ?? null)
              : null,
          });
          line.domains = domains.value.map((d) => d.host);
          line.notes.push(...domains.notes);
          const onDeploServer =
            (await machineServer(line.sourceServerId)) != null;
          for (const host of new Set(
            domains.value.filter((d) => d.generated).map((d) => d.host),
          ))
            line.notes.push(
              onDeploServer
                ? `${host} is {panel}'s own temporary address. It names this machine, so it stays when the app lands here; anywhere else the app gets a temporary address of Deplo's instead, with the same routes.`
                : `${host} is {panel}'s own temporary address - Deplo cannot take it, so this app gets a temporary address of Deplo's instead, with the same routes.`,
            );
          for (const host of line.domains)
            if (foreignHosts.has(host))
              line.notes.push(
                `${host} is already routed by another team on this Deplo, so this app gets an address of Deplo's instead - same routes.`,
              );

          if (isCompose) {
            const yamlText = (detail as SourceCompose).composeFile ?? "";
            const adapted = adaptComposeForDeplo(
              yamlText,
              composePlatform(c, svc),
            );
            const blocked = composeBlockers(adapted.compose, {
              mayMountHost,
              mayExposePorts,
            });
            if (!yamlText.trim())
              line.notes.push(
                "The compose file lives in a git repository - Deplo will try to fetch the resolved file at import time.",
              );
            line.notes.push(...adapted.changes);
            line.notes.push(...composeAdvice(adapted.compose));
            if (blocked.length > 0 && line.status === "new") {
              line.status = "needs_grant";
              line.notes.push(...blocked);
            }
          } else {
            const app = detail as SourceApplication;
            const src = mapSource(app);
            line.buildsFromSource = src.value.kind === "git";
            line.notes.push(...src.notes);
            line.notes.push(...mapBuildSettings(app).notes);
            const wantedPorts = mapPorts(app);
            line.notes.push(...wantedPorts.notes);
            if (wantedPorts.value.length > 0 && !mayExposePorts) {
              line.status = line.status === "exists" ? "exists" : "needs_grant";
              line.notes.push(
                `Publishes ${wantedPorts.value
                  .map((p) => p.published)
                  .join(
                    ", ",
                  )} on the host, which needs the publish-ports grant - without it the app still comes across, those ports do not.`,
              );
            }
            line.notes.push(...unsupportedNotes(app));
            if (
              (app.mounts ?? []).some((m) => m.type === "bind") &&
              !mayMountHost
            ) {
              line.status = line.status === "exists" ? "exists" : "needs_grant";
              line.notes.push(
                "Has a bind mount of a host folder, which needs the host-volumes grant - without it the app still comes across, that one folder does not.",
              );
            }
          }
          services[index] = line;
        },
      );

      environments.push({
        sourceId: env.environmentId,
        name: env.name,
        exists: existingEnv != null,
        services,
      });
    }

    planned.push({
      sourceId: p.projectId,
      name: p.name,
      exists: existingProject != null,
      environments,
    });
  }

  const panel = sourceClient(c).displayName;
  for (const p of planned)
    for (const env of p.environments)
      for (const svc of env.services)
        svc.notes = svc.notes.map((n) => withPanel(n, panel));

  const used = new Set(
    planned.flatMap((p) =>
      p.environments.flatMap((e) =>
        e.services.filter((s) => s.targetKind).map((s) => s.sourceServerId),
      ),
    ),
  );
  return {
    platform: c.kind,
    sourceUrl: c.baseUrl,
    orgName: sourceTeam.name,
    otherTeams,
    projects: planned,
    servers: await planMachines(c, teamId, servers, {
      probe: true,
      only: used,
    }),
    members: await planMembers(c, teamId),
  };
}

interface ExistingNames {
  projects: Map<string, string>;
  environments: Map<string, string>;
  apps: Map<string, string>;
  databases: Map<string, string>;
}

function nothingHere(): ExistingNames {
  return {
    projects: new Map(),
    environments: new Map(),
    apps: new Map(),
    databases: new Map(),
  };
}

async function existingNames(teamId: string): Promise<ExistingNames> {
  const projects = new Map<string, string>();
  const environments = new Map<string, string>();
  for (const p of await listProjects()) {
    projects.set(p.name.trim().toLowerCase(), p.id);
    for (const e of await listEnvironmentsForProject(p.id))
      environments.set(`${p.id}:${e.name.trim().toLowerCase()}`, e.id);
  }

  const appRows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(eq(appsTable.teamId, teamId));
  const apps = new Map<string, string>();
  for (const a of appRows)
    if (a.environmentId)
      apps.set(`${a.environmentId}:${a.name.trim().toLowerCase()}`, a.id);

  const dbRows = await getDb()
    .select({ id: databasesTable.id, name: databasesTable.name })
    .from(databasesTable)
    .where(eq(databasesTable.teamId, teamId));
  const databases = new Map<string, string>();
  for (const d of dbRows) databases.set(d.name.trim().toLowerCase(), d.id);

  return { projects, environments, apps, databases };
}

async function hostnamesOwnedElsewhere(
  teamId: string | null,
): Promise<Set<string>> {
  const rows = await getDb()
    .select({ name: domainsTable.name, teamId: appsTable.teamId })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId));
  const out = new Set<string>();
  for (const r of rows)
    if (teamId === null || r.teamId !== teamId)
      out.add(r.name.trim().toLowerCase());
  return out;
}
