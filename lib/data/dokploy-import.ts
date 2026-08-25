import "server-only";

// https://deplo.build/docs/guides/move-from-dokploy

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import yaml from "../yaml";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  dokployImportItems as itemsTable,
  dokployImports as runsTable,
  dokploySourceAddresses as sourceAddressesTable,
  domains as domainsTable,
  environments as environmentsTable,
  projects as projectsTable,
  serverTeams as serverTeamsTable,
  servers as serversTable,
  sharedEnvVars as sharedVarsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { mapLimit } from "../utils";
import { getCurrentUser } from "../auth";
import {
  canExposePorts,
  canMountHostVolumes,
  hasCapability,
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  requireTeamWide,
} from "../membership";
import { assertSafeOutboundUrl } from "../outbound-url";
import {
  composeBuildReachesHost,
  composeClaimsReservedName,
  composeHasHostBindMount,
  composeJoinsForeignNetwork,
  composeMountsForeignStorage,
  composeNeedsHostPrivileges,
  composePublishesPorts,
  composeFileBindings,
  composeUsesExternalMerge,
  lintCompose,
  composeHostPorts,
} from "../deploy/compose-lint";
import type { BuildConfig, VolumeMount } from "../types";
import { reservedMountPath } from "../apps/volume-model";

import {
  DOKPLOY_DB_KINDS,
  activeOrganizationName,
  getConvertedCompose,
  getEnvironment,
  getService,
  listMembers,
  listProjects as listDokployProjects,
  listSchedules,
  listServers,
  normalizeDokployBaseUrl,
  serviceDisplayName,
  stopService,
  type DokployApplication,
  type DokployCompose,
  type DokployCredential,
  type DokployDatabase,
  type DokployDbKind,
  type DokployEnvironment,
  type DokployProject,
} from "../dokploy/client";
import {
  deploEngineFor,
  envNeedsInterpolation,
  mapBuildSettings,
  mapDatabase,
  mapDomains,
  mapLogo,
  mapMounts,
  mapResources,
  mapSource,
  cloneTarget,
  composeAsRepoApp,
  composeBuildServices,
  composeVolumeMounts,
  volumeLabel,
  parseEnvBlob,
  portNotes,
  adaptComposeForDeplo,
  retargetPlatformEnvFiles,
  unsupportedNotes,
  type MappedDomain,
} from "../dokploy/map";

import { addBasicAuthUser } from "./basic-auth";
import { addExistingMember, mintRegistrationLink } from "./members";
import { createApp, setAppVolumes, updateAppResources } from "./apps";
import { writeAppFile } from "./app-files";
import { createCronJob } from "./crons";
import {
  createDatabase,
  isValidExposePort,
  setDatabaseMounts,
} from "./databases";
import {
  type DomainPatch,
  addDomain,
  addImportedDomains,
  applyImportedRoute,
  updateDomain,
  type ImportedRoute,
} from "./domains";
import { createEnvironment, listEnvironmentsForProject } from "./environments";
import { setAppEnv } from "./env";
import { createProject, defaultEnvironmentFor, listProjects } from "./projects";
import {
  canHostWorkloads,
  getServerById,
  listServersForTeam,
  uninstallMigrationSource,
  updateServerAddress,
} from "./servers";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
  resolveServerIp,
} from "../deploy/domains";
import { saveSharedVar } from "./shared-vars";
import { recordActivity } from "./activity";
import { runAsMigration } from "./migration-guard";
import { publishMigrationChanged } from "../graphql/pubsub";

/**
 * Import a Dokploy instance's projects into this team.
 */

/* ------------------------------------------------------------------ */
/* DTOs                                                               */
/* ------------------------------------------------------------------ */

/** What one Dokploy service would become here, and whether it can. */
export type PlanStatus = "new" | "exists" | "unsupported" | "needs_grant";

export interface PlanService {
  sourceId: string;
  /** `application` | `compose` | one of the five engine tables. */
  kind: string;
  name: string;
  /** `app` | `database`, or null when Deplo has no such thing. */
  targetKind: string | null;
  status: PlanStatus;
  /** The Dokploy server it runs on; empty string means Dokploy's own host. */
  sourceServerId: string;
  /**
   * Whether Deplo would ever COMPILE this, which is what makes a build server mean
   * anything for it.
   */
  buildsFromSource: boolean;
  /**
   * Deplo's OWN engine id for a database (`mongo` over there is `mongodb` here),
   * so a review screen can show the engine's real brand mark instead of a generic
   * glyph.
   */
  engine: string | null;
  /**
   * The host port this database publishes on Dokploy, or null when it publishes
   * none (and for anything that is not a database).
   */
  exposedPort: number | null;
  /** Hostnames that would be imported (the throwaway ones already dropped). */
  domains: string[];
  /**
   * The icon this service would arrive with, already validated, or null when it
   * has none.
   */
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

/**
 * One MACHINE behind that Dokploy, and whether Deplo can reach its disk. Deplo
 * copies a volume by asking the agent ON the host that holds it - there is no
 * other way in (ADR-0006), and agents cannot dial each other.
 */
export interface PlanServer {
  sourceId: string;
  name: string;
  ipAddress: string | null;
  /** The Deplo server sitting at that address, when there is one. */
  deploServerId: string | null;
  deploServerName: string | null;
}

export interface PlanMember {
  email: string;
  name: string;
  /** The role they held on Dokploy, for the admin to act on. Not imported. */
  sourceRole: string;
  /** Already has a deplo account (matched on email). */
  hasAccount: boolean;
  /** Already a member of this team. */
  inTeam: boolean;
}

export interface DokployPlan {
  sourceUrl: string;
  orgName: string | null;
  projects: PlanProject[];
  servers: PlanServer[];
  members: PlanMember[];
}

export interface ImportItemDTO {
  path: string;
  sourceKind: string;
  sourceName: string;
  /** The Dokploy service id, on the rows that are a service. Null everywhere else. */
  sourceId: string | null;
  outcome: string;
  targetKind: string | null;
  targetId: string | null;
  message: string | null;
  /** When it happened. Null on rows written before the report became a log. */
  at: string | null;
}

export interface ImportRunDTO {
  id: string;
  sourceUrl: string;
  orgName: string | null;
  actor: string;
  status: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** `'config'` | `'data'` | `'done'` - which half it is in. */
  phase: string;
  /** Steps done and steps to do IN THE CURRENT PHASE. The two halves count
   *  different things (projects, then services with data), so one running total
   *  across both would be a number that means nothing in either. */
  doneSteps: number;
  totalSteps: number;
  /** What it is on right now, as a person would say it. */
  stepLabel: string | null;
  /** Somebody asked it to stop; it notices between steps. */
  stopRequested: boolean;
  /**
   * When the process driving this run last said it was alive, or null while
   * nothing has picked it up.
   */
  heartbeatAt: string | null;
  /** When its report was closed by the person who started it. Null while the
   *  wizard should still open on this run - see the column's own doc. */
  reportSeenAt: string | null;
  /**
   * The path of the last thing this run touched (`Project / Environment /
   * service`), or null before it has touched anything.
   */
  lastPath: string | null;
}

export interface ImportProjectResult {
  projectName: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  items: ImportItemDTO[];
}

export interface DokployInvite {
  email: string;
  name: string;
  /** The single-use registration link, or null when they were added directly. */
  link: string | null;
  outcome: string;
  message: string | null;
}

/** How a Dokploy server maps onto one of ours. `from: ""` is Dokploy's own host. */
export interface ServerChoice {
  from: string;
  to: string;
}

export interface ConnectInput {
  url: string;
  apiKey: string;
  /**
   * Reach an address `lib/outbound-url.ts` would refuse — which is what the
   * internal migration needs (`http://172.17.0.1:3000`). Instance admin only,
   * exactly like `allowPrivateEndpoint` on a git connection or an S3 endpoint.
   */
  allowPrivate?: boolean;
}

/* ------------------------------------------------------------------ */
/* Gates                                                              */
/* ------------------------------------------------------------------ */

/**
 * The entry gate.
 */
export async function assertImportGate(): Promise<{ teamId: string }> {
  await requireTeamWide("import from Dokploy");
  const { teamId } = await requireCapability("create_projects");
  return { teamId };
}

/**
 * Turn the typed address + key into a credential, refusing an address deplo must
 * not dial. Same shape as `connectGitProvider`: the private-address escape hatch
 * asserts instance admin AT the decision, never inherits it from a caller.
 */
export async function credentialFor(
  input: ConnectInput,
): Promise<DokployCredential> {
  const baseUrl = normalizeDokployBaseUrl(input.url);
  if (input.allowPrivate) await requireInstanceAdmin();
  else
    await assertSafeOutboundUrl(baseUrl, "Dokploy address", {
      allowHttp: true,
    });
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("Paste the Dokploy API key");
  return { baseUrl, apiKey };
}

/* ------------------------------------------------------------------ */
/* Reading the source tree                                            */
/* ------------------------------------------------------------------ */

/**
 * One Dokploy service as `project.all` gives it: an id, a kind, and whatever else
 * happened to be projected.
 */
interface SourceService {
  kind: "application" | "compose" | DokployDbKind;
  id: string;
  /** From the tree when it was there; the authority is the detail row. */
  name: string;
  serverId: string;
}

function servicesOf(env: DokployEnvironment): SourceService[] {
  const out: SourceService[] = [];
  for (const a of env.applications ?? [])
    out.push({
      kind: "application",
      id: a.applicationId,
      name: a.name?.trim() ?? "",
      serverId: a.serverId ?? "",
    });
  for (const c of env.compose ?? [])
    out.push({
      kind: "compose",
      id: c.composeId,
      name: c.name?.trim() ?? "",
      serverId: c.serverId ?? "",
    });
  for (const kind of DOKPLOY_DB_KINDS)
    for (const row of (env[kind] ?? []) as DokployDatabase[]) {
      const id = row[`${kind}Id`];
      if (typeof id !== "string") continue;
      out.push({
        kind,
        id,
        name: row.name?.trim() ?? "",
        serverId: row.serverId ?? "",
      });
    }
  return out;
}

/** The detail call for one service — the only shape difference between kinds. */
function loadService(
  c: DokployCredential,
  svc: SourceService,
): Promise<DokployApplication | DokployCompose | DokployDatabase> {
  return getService(c, svc.kind, svc.id);
}

/** What to call a service Deplo will NOT import: worth one detail call, since
 *  the tree carries no name for a database and an id names nothing to anybody. */
async function nameOfService(
  c: DokployCredential,
  svc: SourceService,
): Promise<string> {
  if (svc.name?.trim()) return svc.name;
  return loadService(c, svc)
    .then((d) => nameOf(d, svc))
    .catch(() => svc.id);
}

/**
 * How many services a compose file declares, or null when it is not valid YAML.
 */
function composeServiceCount(compose: string): number | null {
  let doc: unknown;
  try {
    doc = yaml.load(compose);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return 0;
  const services = (doc as { services?: unknown }).services;
  return services && typeof services === "object" && !Array.isArray(services)
    ? Object.keys(services as Record<string, unknown>).length
    : 0;
}

/**
 * Deplo's own name cap, applied here rather than being hit as an error.
 *
 * Trimmed on a word boundary when there is one within reach, so a truncated
 * name still reads as a name and not as a string that ran out.
 */
function truncateName(name: string): string {
  const MAX = 60;
  const trimmed = name.trim();
  if (trimmed.length <= MAX) return trimmed;
  const cut = trimmed.slice(0, MAX);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("-"));
  return (lastBreak >= MAX - 12 ? cut.slice(0, lastBreak) : cut).trim();
}

/** What to call a service: its detail row's name, the tree's, or its id. */
function nameOf(
  detail: { name?: string | null } | null,
  svc: SourceService,
): string {
  return serviceDisplayName(detail, svc.name || svc.id);
}

/* ------------------------------------------------------------------ */
/* Scan                                                               */
/* ------------------------------------------------------------------ */

/**
 * Read the source instance and describe what an import would do — without writing
 * anything.
 */
export async function scanDokploy(input: ConnectInput): Promise<DokployPlan> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);

  const [orgName, servers, projects] = await Promise.all([
    activeOrganizationName(c),
    listServers(c).catch(() => []),
    listDokployProjects(c),
  ]);

  const existing = await existingNames(teamId);
  const mayMountHost = await canMountHostVolumes();
  const mayExposePorts = await canExposePorts();
  const foreignHosts = await hostnamesOwnedElsewhere(teamId);

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
      // `mapLimit` runs the callback for its side effects, so the slot is filled
      // by index — which is also what keeps the preview in Dokploy's own order.
      await mapLimit(
        list.map((svc, index) => ({ svc, index })),
        5,
        async ({ svc, index }) => {
          const line: PlanService = {
            sourceId: svc.id,
            kind: svc.kind,
            // Replaced by the detail row's name below; the id is what a service whose
            // detail cannot be read is called, since it is all Dokploy gave us.
            name: svc.name || svc.id,
            targetKind:
              svc.kind === "compose" || svc.kind === "application"
                ? "app"
                : deploEngineFor(svc.kind)
                  ? "database"
                  : null,
            status: "new",
            sourceServerId: svc.serverId,
            // Only a repository source ever reaches the builder; every other kind
            // flips this below or leaves it false.
            buildsFromSource: false,
            engine: deploEngineFor(svc.kind as DokployDbKind),
            exposedPort: null,
            domains: [],
            logo: null,
            notes: [],
          };
          // An engine Deplo does not have is settled here, without a detail call:
          // asking about a libsql row we can do nothing with would turn a plain
          // fact into an HTTP 404 in the report.
          if (line.targetKind === null) {
            line.status = "unsupported";
            // Its NAME is still worth one call. `project.all` gives a database nothing but its
            // id, so the line otherwise reads "jiNnZQIEqsTkIARVHq0He has no equivalent here" -
            // true, and useless to the person who has to decide what to do about it.
            line.name = await nameOfService(c, svc);
            line.notes.push(`Deplo has no ${svc.kind} engine.`);
            services[index] = line;
            return;
          }

          let detail: DokployApplication | DokployCompose | DokployDatabase;
          try {
            detail = await loadService(c, svc);
          } catch (e) {
            line.status = "unsupported";
            line.notes.push(
              e instanceof Error
                ? e.message
                : "Dokploy would not return this service.",
            );
            services[index] = line;
            return;
          }

          // The detail row is the first place a name is guaranteed: `project.all`
          // gives a database nothing but its id, so until now this line may have had
          // no name at all.
          line.name = nameOf(detail, svc);
          line.logo = mapLogo((detail as DokployApplication).icon);

          if (line.targetKind === "database") {
            const key = line.name.trim().toLowerCase();
            if (existing.databases.has(key)) line.status = "exists";
            const mappedDb = mapDatabase(svc.kind as DokployDbKind, {
              ...(detail as DokployDatabase),
              name: line.name,
            });
            // The port the review needs to talk about.
            line.exposedPort = mappedDb.value?.exposedPort ?? null;
            line.notes.push(...mappedDb.notes);
            services[index] = line;
            return;
          }

          // Apps: name is unique per (project, environment) for our purposes.
          const homeKey = existingEnv
            ? `${existingEnv}:${line.name.trim().toLowerCase()}`
            : null;
          if (homeKey && existing.apps.has(homeKey)) line.status = "exists";

          const isCompose = svc.kind === "compose";
          const domains = mapDomains((detail as DokployApplication).domains, {
            isCompose,
          });
          line.domains = domains.value.map((d) => d.host);
          line.notes.push(...domains.notes);
          // Said BEFORE anyone presses import, because it is the one thing about a
          // migrated app that is not the same afterwards: the address. The route
          // survives; the name cannot (it carries the source server's IP).
          for (const host of new Set(
            domains.value.filter((d) => d.generated).map((d) => d.host),
          ))
            line.notes.push(
              `${host} is Dokploy's own temporary address - Deplo cannot take it, so this app gets a temporary address of Deplo's instead, with the same routes.`,
            );
          for (const host of line.domains)
            if (foreignHosts.has(host))
              line.notes.push(
                `${host} is already routed by another team on this Deplo, so this app gets an address of Deplo's instead - same routes.`,
              );

          if (isCompose) {
            const yamlText = (detail as DokployCompose).composeFile ?? "";
            const adapted = adaptComposeForDeplo(yamlText);
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
            const app = detail as DokployApplication;
            // The same call the notes come from: a git source is the only one Deplo
            // builds, so this costs nothing beyond keeping the result.
            const src = mapSource(app);
            line.buildsFromSource = src.value.kind === "git";
            line.notes.push(...src.notes);
            line.notes.push(...mapBuildSettings(app).notes);
            line.notes.push(...portNotes(app));
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

  return {
    sourceUrl: c.baseUrl,
    orgName,
    projects: planned,
    servers: await planMachines(c, teamId, servers),
    members: await planMembers(c, teamId),
  };
}

/**
 * Compose warnings worth a REPORT line, borrowed from the editor's own linter.
 */
function composeAdvice(compose: string): string[] {
  return lintCompose(compose)
    .filter(
      (d) =>
        d.rule === "reserved-service-name" ||
        d.rule === "network-aliases-dropped" ||
        // A service on the host's network namespace is not reachable through Deplo's proxy,
        // so its address (if it had one over there) is now a host port and nothing else.
        d.rule === "network-mode-host" ||
        d.rule === "network-mode-conflict",
    )
    .map((d) => d.message);
}

/**
 * Which of deplo's compose gates this file would trip, as sentences. Deliberately
 * the SAME predicates `createApp` runs (`lib/deploy/compose-lint.ts`), because the
 * preview has no business disagreeing with the write path.
 */
function composeBlockers(
  compose: string,
  grants: { mayMountHost: boolean; mayExposePorts: boolean },
): string[] {
  const out: string[] = [];
  const merge = composeUsesExternalMerge(compose);
  if (merge)
    out.push(
      `Uses \`${merge}\`, which Deplo refuses in a compose file - inline what it pulls in.`,
    );
  const reserved = composeClaimsReservedName(compose);
  if (reserved)
    out.push(
      `A service is called "${reserved}", a name Deplo's own infrastructure uses on the shared network - rename it.`,
    );
  if (!grants.mayExposePorts && composePublishesPorts(compose))
    out.push("Publishes host ports, which needs the expose-ports grant.");
  if (
    !grants.mayMountHost &&
    (composeHasHostBindMount(compose) ||
      composeNeedsHostPrivileges(compose) ||
      composeMountsForeignStorage(compose) ||
      composeBuildReachesHost(compose) ||
      composeJoinsForeignNetwork(compose))
  )
    out.push(
      "Reaches the host (a bind mount, a privilege, an external volume or network), which needs the host-volumes grant.",
    );
  return out;
}

/** Everything already in this team, by lowercase name, for the skip decision. */
async function existingNames(teamId: string): Promise<{
  projects: Map<string, string>;
  environments: Map<string, string>;
  apps: Map<string, string>;
  databases: Map<string, string>;
}> {
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

/**
 * Every hostname on this instance that belongs to a DIFFERENT team. Knowing the
 * set up front is what lets the preview say so before anything is written.
 */
async function hostnamesOwnedElsewhere(teamId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ name: domainsTable.name, teamId: appsTable.teamId })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId));
  const out = new Set<string>();
  for (const r of rows)
    if (r.teamId !== teamId) out.add(r.name.trim().toLowerCase());
  return out;
}

/**
 * Every machine behind that Dokploy, each paired with the Deplo server at the same
 * address - or nothing, when Deplo has no agent there.
 */
export async function dokployMachines(
  c: DokployCredential,
  teamId: string,
): Promise<PlanServer[]> {
  return planMachines(c, teamId, await listServers(c).catch(() => []));
}

/**
 * The addresses somebody has already corrected for this Dokploy, by machine.
 */
async function rememberedAddresses(
  teamId: string,
  sourceUrl: string,
): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({
      sourceId: sourceAddressesTable.sourceId,
      address: sourceAddressesTable.address,
    })
    .from(sourceAddressesTable)
    .where(
      and(
        eq(sourceAddressesTable.teamId, teamId),
        eq(sourceAddressesTable.sourceUrl, sourceUrl),
      ),
    );
  return new Map(rows.map((r) => [r.sourceId, r.address]));
}

/**
 * Remember where a machine of this Dokploy is reached, so the next attempt
 * registers it there instead of at the panel's name. Overwrites: the last answer
 * is the one somebody just proved.
 */
export async function rememberDokployMachineAddress(
  sourceUrl: string,
  sourceId: string,
  address: string,
): Promise<void> {
  const teamId = await requireActiveTeamId();
  const value = address.trim();
  if (!value) throw new Error("Address is required");
  await getDb()
    .insert(sourceAddressesTable)
    .values({
      teamId,
      sourceUrl,
      sourceId,
      address: value,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [
        sourceAddressesTable.teamId,
        sourceAddressesTable.sourceUrl,
        sourceAddressesTable.sourceId,
      ],
      set: { address: value, updatedAt: nowIso() },
    });
}

/**
 * Point Deplo at where a machine of this Dokploy really is, and REMEMBER it.
 */
export async function setDokployMachineAddress(input: {
  sourceUrl: string;
  sourceId: string;
  serverId: string;
  address: string;
}): Promise<{ warning: string | null }> {
  const { warning } = await updateServerAddress({
    id: input.serverId,
    address: input.address,
    // The panel's name stays in `host`: it is what pairs this row with the
    // Dokploy machine on a second pass. See the flag's own doc.
    keepHost: true,
  });
  await rememberDokployMachineAddress(
    input.sourceUrl,
    input.sourceId,
    input.address,
  );
  return { warning };
}

async function planMachines(
  c: DokployCredential,
  teamId: string,
  servers: { serverId: string; name: string; ipAddress?: string | null }[],
): Promise<PlanServer[]> {
  // Migration sources stay in this list on purpose: matching a machine to the
  // agent that can read its disks is the ONE lookup they exist for, and a second
  // pass of the same import has to find the one the first pass registered.
  const mine = (await listServersForTeam(teamId)).filter((s) => !s.storageOnly);
  const self = deploHostSelfAddresses();
  const remembered = await rememberedAddresses(teamId, c.baseUrl);
  const at = (address: string | null) => {
    const a = address?.trim().toLowerCase();
    if (!a) return null;
    const hit =
      mine.find(
        (s) =>
          s.ip?.trim().toLowerCase() === a ||
          s.host?.trim().toLowerCase() === a,
      ) ??
      // The same-machine case, which the wizard has a toggle for: the other platform runs
      // on the box Deplo runs on.
      (isDeploHostServer({ ip: a, host: a }, self)
        ? mine.find((s) => isDeploHostServer(s, self))
        : undefined);
    return hit ? { deploServerId: hit.id, deploServerName: hit.name } : null;
  };

  let ownAddress: string | null = null;
  try {
    ownAddress = new URL(c.baseUrl).hostname;
  } catch {
    /* the client already normalised this; a bad one just matches nothing */
  }

  /**
   * A remembered correction wins over the derived address, and BOTH are tried for
   * the match.
   */
  const machine = (sourceId: string, name: string, derived: string | null) => {
    const address = remembered.get(sourceId) ?? derived;
    return {
      sourceId,
      name,
      ipAddress: address,
      deploServerId: null as string | null,
      deploServerName: null as string | null,
      ...(at(address) ?? at(derived) ?? {}),
    };
  };

  return [
    machine("", "The Dokploy host", ownAddress),
    ...servers.map((s) => machine(s.serverId, s.name, s.ipAddress ?? null)),
  ];
}

/** Dokploy's members, told apart by whether they already exist here. */
async function planMembers(
  c: DokployCredential,
  teamId: string,
): Promise<PlanMember[]> {
  let rows: Awaited<ReturnType<typeof listMembers>>;
  try {
    rows = await listMembers(c);
  } catch {
    // A member-scoped key cannot list the organization. Not knowing who is on the
    // other side must not stop a project import.
    return [];
  }

  const people = rows
    .map((m) => ({
      email: (m.user?.email ?? m.email ?? "").trim().toLowerCase(),
      name: (m.user?.name ?? m.name ?? "").trim(),
      sourceRole: (m.role ?? "member").trim(),
    }))
    .filter((p) => p.email.includes("@"));
  if (people.length === 0) return [];

  const accounts = await getDb()
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(
      inArray(
        sql`lower(${usersTable.email})`,
        people.map((p) => p.email),
      ),
    );
  const byEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a.id]));
  const memberIds = new Set(await teamMemberIds(teamId));

  return people.map((p) => {
    const userId = byEmail.get(p.email) ?? null;
    return {
      ...p,
      name: p.name || p.email,
      hasAccount: userId != null,
      inTeam: userId != null && memberIds.has(userId),
    };
  });
}

async function teamMemberIds(teamId: string): Promise<string[]> {
  const rows = await getDb().execute<{ user_id: string }>(
    sql`select user_id from memberships where team_id = ${teamId}`,
  );
  const list = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: unknown[] }).rows ?? []);
  return (list as { user_id: string }[]).map((r) => r.user_id);
}

/* ------------------------------------------------------------------ */
/* The run + its report                                               */
/* ------------------------------------------------------------------ */

/**
 * Open a run. Any run this team left `running` is closed as failed first: the only
 * way one stays open is a tab that went away, and a history with two live runs in
 * it cannot be read. That is also why there is no boot reconcile to add.
 */
export async function beginDokployImport(input: {
  url: string;
  orgName?: string | null;
}): Promise<string> {
  const { teamId } = await assertImportGate();
  const user = await getCurrentUser();
  const db = getDb();
  const now = nowIso();

  const interrupted = await db
    .update(runsTable)
    .set({ status: "failed", error: "Interrupted", finishedAt: now })
    .where(and(eq(runsTable.teamId, teamId), eq(runsTable.status, "running")))
    .returning({ id: runsTable.id });
  // A run nobody is running must not go on holding its services hostage: this is
  // the door an abandoned tab leaves by, and everything it created is handed back
  // the moment somebody starts the next migration.
  for (const r of interrupted) await releaseMigrating(r.id);

  const id = newId("dimp");
  await db.insert(runsTable).values({
    id,
    teamId,
    sourceUrl: normalizeDokployBaseUrl(input.url),
    orgName: input.orgName?.trim() || null,
    actor: user?.name ?? "someone",
    // The id as well as the display name: it is what says whose wizard opens on
    // this run again (`resumableDokployImport`), and the runner overwrites it
    // with the same value when it takes the plan.
    actorUserId: user?.id ?? null,
    status: "running",
    created: 0,
    skipped: 0,
    failed: 0,
    manual: 0,
    error: null,
    startedAt: now,
    finishedAt: null,
  });
  publishMigrationChanged();
  return id;
}

/**
 * Attempts before Deplo stops trying to take its agent off a migration source and
 * asks a person instead: the one made while the wizard is still open, then two
 * from the sweep.
 */
const UNINSTALL_ATTEMPTS = 3;

/** How long the ladder waits before attempt N+1: a minute, then five. Short,
 *  because nothing is being retried here except reaching a machine that was
 *  answering a moment ago. */
const UNINSTALL_BACKOFF_MS = [60_000, 5 * 60_000];

/**
 * The deadline for the ONE attempt made inline, while somebody is watching the
 * wizard finish.
 */
const UNINSTALL_INLINE_DEADLINE_MS = 15_000;

/** How many stuck sources one sweep tick picks up. */
const UNINSTALL_DRAIN_BATCH = 8;

/**
 * The last act of a migration: take Deplo's agent back off every machine it was
 * installed on to read Dokploy, and forget those rows.
 */
async function removeMigrationSources(
  runId: string,
  teamId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const sources = (await listServersForTeam(teamId)).filter(
    (s) => s.importOnly,
  );
  if (sources.length === 0) return;

  if (!opts.force && (await hasStrandedVolume(runId))) {
    for (const s of sources)
      await appendRunItem(runId, {
        path: s.name,
        sourceKind: "server",
        sourceName: s.name,
        outcome: "manual",
        message:
          `Deplo's agent is still on ${s.name}: data that did not copy is still ` +
          `on it. Remove it once the copy is done.`,
      });
    return;
  }

  const [run] = await getDb()
    .select({ actor: runsTable.actor })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  await scheduleSourceUninstalls(
    sources,
    runId,
    teamId,
    run?.actor ?? "the migration",
  );
}

/**
 * A volume this run could not copy. Its bytes are still on the source host and
 * the agent is the only way to fetch them, so nothing may take that agent off
 * until a person says so.
 */
async function hasStrandedVolume(runId: string): Promise<boolean> {
  const stranded = await getDb()
    .select({ id: itemsTable.id })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.runId, runId),
        eq(itemsTable.sourceKind, "volume"),
        eq(itemsTable.outcome, "failed"),
      ),
    )
    .limit(1);
  return stranded.length > 0;
}

/** Put every one of these sources on the uninstall ladder and take the first
 *  rung now. `runId` is null when nobody's report is waiting on the answer. */
async function scheduleSourceUninstalls(
  sources: { id: string; name: string }[],
  runId: string | null,
  teamId: string,
  actor: string,
): Promise<void> {
  for (const s of sources) {
    // The intent FIRST, so a process that dies on the next line still leaves a
    // row the sweep will pick up. `attempts: 0` because the try below is the
    // first one.
    await getDb()
      .update(serversTable)
      .set({
        uninstallRunId: runId,
        uninstallAttempts: 0,
        uninstallError: "",
        uninstallNextAt: nowIso(),
      })
      .where(eq(serversTable.id, s.id));
    await attemptSourceUninstall(
      { id: s.id, name: s.name, attempts: 0, runId },
      teamId,
      actor,
      new Date(),
      UNINSTALL_INLINE_DEADLINE_MS,
    );
  }
}

/**
 * The wizard was walked away from, and the machines it was reading are somebody
 * else's. The wizard calls it on the way out; the identity is the person leaving,
 * and the capability is the one that registered the sources in the first place.
 */
export async function abandonDokployImport(): Promise<number> {
  const { teamId } = await requireCapability("create_projects");
  const actor = (await getCurrentUser())?.name ?? "the migration";

  const [latest] = await getDb()
    .select({ id: runsTable.id, status: runsTable.status })
    .from(runsTable)
    .where(eq(runsTable.teamId, teamId))
    .orderBy(desc(runsTable.seq))
    .limit(1);
  // `stopped` is a pause, not an ending: re-running is how a stopped migration is
  // resumed (see `stopDokployImport`), and it can only be resumed through the
  // agents that are still on those machines.
  if (latest?.status === "running" || latest?.status === "stopped") return 0;
  if (latest && (await hasStrandedVolume(latest.id))) return 0;

  const sources = (await listServersForTeam(teamId)).filter(
    // Already on the ladder, or already given up on: both are somebody else's
    // decision to leave alone. `uninstallError` is what puts the machine in
    // front of a person, and re-arming it would hide it again.
    (s) => s.importOnly && !s.uninstallPending && !s.uninstallError,
  );
  if (sources.length === 0) return 0;
  await scheduleSourceUninstalls(sources, null, teamId, actor);
  return sources.length;
}

/**
 * One attempt at taking Deplo off one migration source, and what to do with the
 * answer.
 */
async function attemptSourceUninstall(
  source: { id: string; name: string; attempts: number; runId: string | null },
  teamId: string,
  actor: string,
  now: Date,
  deadlineMs?: number,
): Promise<void> {
  let error = "";
  try {
    const res = await uninstallMigrationSource(
      source.id,
      actor,
      teamId,
      deadlineMs,
    );
    error = res.removed ? "" : (res.error ?? "the agent is still installed");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (!error) return;

  const attempts = source.attempts + 1;
  if (attempts < UNINSTALL_ATTEMPTS) {
    const wait =
      UNINSTALL_BACKOFF_MS[Math.min(attempts, UNINSTALL_BACKOFF_MS.length) - 1];
    await getDb()
      .update(serversTable)
      .set({
        uninstallAttempts: attempts,
        uninstallError: "",
        uninstallNextAt: new Date(now.getTime() + wait).toISOString(),
      })
      .where(eq(serversTable.id, source.id));
    return;
  }

  await getDb()
    .update(serversTable)
    .set({
      uninstallAttempts: attempts,
      uninstallError: error,
      uninstallNextAt: null,
    })
    .where(eq(serversTable.id, source.id));
  if (source.runId) {
    await appendRunItem(source.runId, {
      path: source.name,
      sourceKind: "server",
      sourceName: source.name,
      outcome: "manual",
      message:
        `Deplo could not remove its own agent from ${source.name} after ` +
        `${UNINSTALL_ATTEMPTS} tries: ${error}. Remove it from Settings → Servers.`,
    });
    await refreshCounts(source.runId, teamId);
  }
  await recordActivity(
    "member",
    `Could not remove Deplo's agent from ${source.name} after ${UNINSTALL_ATTEMPTS} tries: ${error}`,
    actor,
    null,
    teamId,
  );
}

/**
 * The sweep half: retry every migration source whose uninstall is still owed.
 * There is no catch-up window to miss: the predicate is a DB state, so a tick that
 * never ran costs nothing but the delay.
 */
export async function drainMigrationSourceUninstalls(
  now: Date = new Date(),
): Promise<void> {
  const due = await getDb()
    .select({
      id: serversTable.id,
      name: serversTable.name,
      attempts: serversTable.uninstallAttempts,
      runId: serversTable.uninstallRunId,
    })
    .from(serversTable)
    .where(
      and(
        eq(serversTable.importOnly, true),
        isNotNull(serversTable.uninstallNextAt),
        lte(serversTable.uninstallNextAt, now.toISOString()),
      ),
    )
    .orderBy(asc(serversTable.uninstallNextAt))
    .limit(UNINSTALL_DRAIN_BATCH);

  for (const row of due) {
    // The team comes from the GRANT rather than the run: a migration source is
    // granted to exactly one team at registration, and that outlives the run row.
    const [grant] = await getDb()
      .select({ teamId: serverTeamsTable.teamId })
      .from(serverTeamsTable)
      .where(eq(serverTeamsTable.serverId, row.id))
      .limit(1);
    if (!grant) continue;
    const [run] = row.runId
      ? await getDb()
          .select({ actor: runsTable.actor })
          .from(runsTable)
          .where(eq(runsTable.id, row.runId))
          .limit(1)
      : [];
    await attemptSourceUninstall(
      row,
      grant.teamId,
      run?.actor ?? "the migration",
      now,
    );
  }
}

/**
 * Close a run. Counts come last, because the sweep writes report rows.
 */
export async function finishDokployImport(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  const closed = await getDb()
    .update(runsTable)
    .set({ status: "done", finishedAt: nowIso() })
    .where(
      and(
        eq(runsTable.id, runId),
        eq(runsTable.teamId, teamId),
        eq(runsTable.status, "running"),
      ),
    )
    .returning({ id: runsTable.id });
  if (closed.length > 0) {
    // The services are the team's again before anything else happens: the sweep
    // below dials hosts and can take a minute, and none of that is a reason to
    // keep a finished migration's apps frozen.
    await releaseMigrating(runId);
    await removeMigrationSources(runId, teamId);
  }
  await refreshCounts(runId, teamId);
}

/** The open run of this team, as ids only — the writer's cheap ownership check.
 *  Exported for the data cutover, which appends to a run the import opened. */
export async function ownRun(runId: string, teamId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  return rows.length > 0;
}

/** Recount the run's totals from its items, so the history is right even if the
 *  tab that started the import never came back. Exported for the data cutover,
 *  whose rows land in the same run. */
export async function refreshCounts(
  runId: string,
  teamId: string,
): Promise<void> {
  const rows = await getDb()
    .select({ outcome: itemsTable.outcome })
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));
  const count = (o: string) => rows.filter((r) => r.outcome === o).length;
  await getDb()
    .update(runsTable)
    .set({
      created: count("created"),
      skipped: count("skipped"),
      failed: count("failed"),
      // `unsupported` counts as "needs a look": it is a decision left to a person,
      // exactly like `manual`, and its own column would be a fifth number nobody asked
      // for.
      manual: count("manual") + count("unsupported"),
    })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  // Every writer of a run's state goes through here - a project landing, a
  // volume copied, Finish, Stop - so this is the one place the live "a
  // migration is running" chip has to be told about.
  publishMigrationChanged();
}

/**
 * A report collector: rows go to the run AND come back to the caller. `at()`
 * deepens the breadcrumb but SHARES the items array — the caller gets one flat
 * report for the whole project, in the order things happened.
 */
class Report {
  constructor(
    private readonly runId: string | null,
    private readonly path: string[] = [],
    readonly items: ImportItemDTO[] = [],
  ) {}

  /** A child collector one level deeper in the breadcrumb, same run, same list. */
  at(segment: string): Report {
    return new Report(this.runId, [...this.path, segment], this.items);
  }

  async add(entry: {
    path?: string;
    sourceKind: string;
    sourceName: string;
    /** The Dokploy service id, when this row IS a service. What the data cutover
     *  pairs on — see `dokploy_import_items.source_id`. */
    sourceId?: string | null;
    outcome: "created" | "skipped" | "failed" | "manual" | "unsupported";
    targetKind?: string | null;
    targetId?: string | null;
    message?: string | null;
  }): Promise<void> {
    const row: ImportItemDTO = {
      path: entry.path ?? this.path.join(" / "),
      sourceKind: entry.sourceKind,
      sourceName: entry.sourceName,
      sourceId: entry.sourceId ?? null,
      outcome: entry.outcome,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      message: entry.message ?? null,
      // Stamped here, once, so the in-memory copy the caller reads and the row
      // the log reads agree on when it happened.
      at: nowIso(),
    };
    this.items.push(row);
    if (!this.runId) return;
    await getDb()
      .insert(itemsTable)
      .values({ id: newId("dimi"), runId: this.runId, ...row });
    // Everything this run CREATES is the run's to write until it ends.
    if (row.outcome === "created") await markMigrating(this.runId, row);
  }

  /** Every note from a mapper, as its own `manual` line. */
  async notes(
    kind: string,
    name: string,
    notes: string[],
    target?: { kind: string; id: string },
    sourceId?: string | null,
  ): Promise<void> {
    for (const message of notes)
      await this.add({
        sourceKind: kind,
        sourceName: name,
        sourceId: sourceId ?? null,
        outcome: "manual",
        targetKind: target?.kind ?? null,
        targetId: target?.id ?? null,
        message,
      });
  }
}

/**
 * Append ONE line to a run's report, for a caller that has no `Report` tree of its
 * own (the data cutover writes a handful of rows, one volume at a time, across
 * separate requests).
 */
export async function appendRunItem(
  runId: string,
  entry: {
    path: string;
    sourceKind: string;
    sourceName: string;
    sourceId?: string | null;
    outcome: "created" | "skipped" | "failed" | "manual" | "unsupported";
    targetKind?: string | null;
    targetId?: string | null;
    message?: string | null;
  },
): Promise<void> {
  await new Report(runId).add(entry);
}

/** Which table holds a target of each kind. Unknown kinds are simply not marked. */
const MIGRATING_TABLES = {
  app: appsTable,
  database: databasesTable,
  project: projectsTable,
  environment: environmentsTable,
} as const;

/** Stamp a freshly created row with the run that is still writing to it. */
async function markMigrating(
  runId: string,
  row: { targetKind: string | null; targetId: string | null },
): Promise<void> {
  const table =
    MIGRATING_TABLES[row.targetKind as keyof typeof MIGRATING_TABLES];
  if (!table || !row.targetId) return;
  await getDb()
    .update(table)
    .set({ migrationRunId: runId })
    .where(eq(table.id, row.targetId));
}

/**
 * Hand everything this run created back to the people who own it.
 */
async function releaseMigrating(runId: string): Promise<void> {
  for (const table of Object.values(MIGRATING_TABLES))
    await getDb()
      .update(table)
      .set({ migrationRunId: null })
      .where(eq(table.migrationRunId, runId));
}

/* ------------------------------------------------------------------ */
/* Import                                                             */
/* ------------------------------------------------------------------ */

export interface ImportProjectInput extends ConnectInput {
  runId: string;
  /** The Dokploy `projectId` to import. */
  projectId: string;
  /** Dokploy server id (or "") → deplo server id. Unmapped falls back to default. */
  servers?: ServerChoice[];
  /**
   * The source service ids to import, out of the project's own. Absent imports
   * everything - a client that cannot express a selection still gets the whole
   * project, which is what every caller did before the wizard grew a tree.
   */
  serviceIds?: string[];
  /**
   * Where each service lands, by its Dokploy id. A service with no entry falls
   * back to `servers` - the per-HOST mapping - exactly as before, so a caller
   * that cannot express a placement is unaffected.
   */
  placements?: ServicePlacement[];
}

/**
 * Import ONE Dokploy project into the active team. The source is re-read here
 * rather than taken from the scan's result: the plan the client holds is a
 * rendering, and app configuration must never arrive from a browser.
 */
/**
 * The import's own writes are exempt from the marker they set. Without this the
 * run would be refused by its own marker on everything after the first write.
 */
export async function importDokployProject(
  input: ImportProjectInput,
): Promise<ImportProjectResult> {
  return runAsMigration(() => runImportDokployProject(input));
}

async function runImportDokployProject(
  input: ImportProjectInput,
): Promise<ImportProjectResult> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const projects = await listDokployProjects(c);
  const source = projects.find((p) => p.projectId === input.projectId);
  if (!source)
    throw new Error("That project is no longer on the Dokploy instance.");

  const report = new Report(input.runId).at(source.name);
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

  // Read ONCE, up here, for the same reason the scan reads it: without the grant a
  // database's port cannot be published at all, and knowing that BEFORE the create is
  // what lets the report say the true reason instead of guessing at whichever one the
  // failed create happened to raise.
  const mayExposePorts = await canExposePorts();

  // Which of OUR servers is each Dokploy machine, as an address match rather than the
  // caller's `servers` mapping - that one falls back to the Deplo host for a machine
  // we have no agent on, which is the right default for "where does this land" and
  // the wrong answer to "is this the same box".
  let machineHosts: Map<string, string | null> | null = null;
  const hostOfMachine = async (sourceServerId: string) => {
    if (!machineHosts)
      machineHosts = new Map(
        (await dokployMachines(c, teamId)).map((m) => [
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

  const projectId = await ensureProject(source, report);
  if (!projectId)
    return {
      projectName: source.name,
      ...tally(report.items),
      items: report.items,
    };

  // What the caller picked, or everything. A service left out is left out
  // SILENTLY: it is a choice made on the review screen, not an event, and a
  // report line per unticked box would bury the ones that need reading.
  const wanted = input.serviceIds ? new Set(input.serviceIds) : null;

  for (const env of source.environments ?? []) {
    const chosen = servicesOf(env).filter((s) => !wanted || wanted.has(s.id));
    // An environment nobody picked anything from is not created empty.
    if (chosen.length === 0) continue;

    const envReport = report.at(env.name);
    const environmentId = await ensureEnvironment(projectId, env, envReport);
    if (!environmentId) continue;

    /** Apps landed in this environment — the link set for its shared vars. */
    const appIds: string[] = [];

    for (const svc of chosen) {
      const isApp = svc.kind === "application" || svc.kind === "compose";
      const targetKind = isApp ? "app" : "database";

      // An engine Deplo does not have is settled without importing anything —
      // but under its own name, not its id (see the scan for why).
      if (!isApp && !deploEngineFor(svc.kind as DokployDbKind)) {
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
      // The DETAIL is loaded here rather than inside each importer, because it is also
      // where the service's real name lives: `project.all` gives a database nothing but
      // its id, so a report scoped before this call would have an empty breadcrumb for
      // exactly the objects hardest to identify.
      let detail: DokployApplication | DokployCompose | DokployDatabase;
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
            e instanceof Error ? e.message : "Dokploy would not return it.",
        });
        continue;
      }

      // Deplo caps a name at 60 characters and so does Dokploy's own column at 63 for
      // `appName` - but its display NAME is free text, and a service called after a team,
      // a region and a cluster goes past it.
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
            detail as DokployApplication & DokployCompose,
            name,
            {
              projectId,
              environmentId,
              serverId:
                placed.get(svc.id)?.serverId ?? serverMap.get(svc.serverId),
              buildServerId: placed.get(svc.id)?.buildServerId ?? null,
            },
            svcReport,
          );
          if (appId) appIds.push(appId);
        } else {
          const placement = placed.get(svc.id);
          const serverId = await targetServerFor(
            placement?.serverId ?? serverMap.get(svc.serverId),
          );
          await importDatabaseService(
            c,
            svc,
            detail as DokployDatabase,
            name,
            {
              serverId,
              // The port the review settled on, or the source's own when it said
              // nothing. `null` is a decision ("publish nothing"), not a silence.
              exposedPort: placement?.exposedPort,
              mayExposePorts,
              // Whether the machine this database runs on over there IS the machine it is about
              // to run on here - the one case where the port it wants is held by the very
              // container we are importing, and stopping that frees it.
              sourceIsTargetHost:
                serverId != null &&
                (await hostOfMachine(svc.serverId)) === serverId,
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

    // `project.all` is a projection: an environment's variable blob is ALWAYS
    // null there, however much it holds, so this asks for the row itself.
    const envBlob =
      env.env ?? (await getEnvironment(c, env.environmentId))?.env ?? null;
    await importSharedVars(envBlob, {
      teamId,
      label: `${source.name} / ${env.name}`,
      environmentIds: [environmentId],
      projectIds: [],
      appIds,
      report: envReport,
    });
  }

  // The project-level blob is available to every app of the project, so it links
  // to all of them — the environment ones each linked their own slice above.
  const projectAppIds = await appIdsInProject(teamId, projectId);
  await importSharedVars(source.env, {
    teamId,
    label: source.name,
    environmentIds: [],
    projectIds: [projectId],
    appIds: projectAppIds,
    report,
  });

  await refreshCounts(input.runId, teamId);
  // Outside every transaction, like every other caller: `recordActivity` opens its
  // own connection and would deadlock pglite from inside one.
  await recordActivity(
    "project",
    `Imported ${source.name} from Dokploy`,
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

/** Dokploy server id (or "") → a deplo server this team can actually deploy to. */
async function resolveServers(
  teamId: string,
  choices: ServerChoice[],
  report: Report,
  projectName: string,
): Promise<Map<string, string | undefined>> {
  const usable = new Set(
    (await listServersForTeam(teamId))
      .filter(canHostWorkloads)
      .map((s) => s.id),
  );
  const out = new Map<string, string | undefined>();
  for (const { from, to } of choices) {
    if (usable.has(to)) out.set(from, to);
    else
      await report.add({
        path: projectName,
        sourceKind: "server",
        sourceName: from || "the Dokploy host",
        outcome: "manual",
        message:
          "The server picked for this Dokploy host is not one this team can deploy to - Deplo's default server was used instead.",
      });
  }
  return out;
}

/** Where ONE service was placed: the host it runs on, and the one it compiles on. */
export interface ServicePlacement {
  /** The Dokploy service id - the `sourceId` a scan reports. */
  serviceId: string;
  serverId: string;
  /** Null (or absent) is Automatic: use a build server if the fleet has one. */
  buildServerId?: string | null;
  /**
   * A database's host port, decided in the review.
   */
  exposedPort?: number | null;
}

/** What resolvePlacements settles for one service. */
interface ResolvedPlacement {
  serverId: string;
  buildServerId: string | null;
  exposedPort?: number | null;
}

/** Dokploy service id → where it lands, for the services the caller placed. */
async function resolvePlacements(
  teamId: string,
  placements: ServicePlacement[],
  report: Report,
  projectName: string,
): Promise<Map<string, ResolvedPlacement>> {
  const out = new Map<string, ResolvedPlacement>();
  if (placements.length === 0) return out;

  const servers = await listServersForTeam(teamId);
  const canRun = new Set(servers.filter(canHostWorkloads).map((s) => s.id));
  // Wider than `canRun` on purpose: a build-only host is a legal builder and an
  // illegal target, which is the whole point of the two columns.
  const canBuild = new Set(
    servers.filter((s) => !s.storageOnly && !s.importOnly).map((s) => s.id),
  );

  for (const p of placements) {
    if (!canRun.has(p.serverId)) {
      await report.add({
        path: projectName,
        sourceKind: "server",
        sourceName: p.serviceId,
        outcome: "manual",
        message:
          "The server picked for this app is not one this team can deploy to - Deplo's default server was used instead.",
      });
      continue;
    }
    let buildServerId: string | null = null;
    if (p.buildServerId) {
      if (canBuild.has(p.buildServerId)) buildServerId = p.buildServerId;
      else
        await report.add({
          path: projectName,
          sourceKind: "server",
          sourceName: p.serviceId,
          outcome: "manual",
          message:
            "The build server picked for this app is not one this team can build on - it builds automatically instead.",
        });
    }
    // A port outside the range createDatabase accepts is refused HERE, where the report
    // can name the service, instead of down at the create where it would read as "the
    // database could not be made".
    let exposedPort = p.exposedPort;
    if (typeof exposedPort === "number" && !isValidExposePort(exposedPort)) {
      await report.add({
        path: projectName,
        sourceKind: "server",
        sourceName: p.serviceId,
        outcome: "manual",
        message: `Port ${exposedPort} is not a port a database can publish (1024-65535) - the one it had on Dokploy was used instead.`,
      });
      exposedPort = undefined;
    }
    out.set(p.serviceId, { serverId: p.serverId, buildServerId, exposedPort });
  }
  return out;
}

async function ensureProject(
  source: DokployProject,
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

/**
 * The deplo Environment for a Dokploy one.
 */
async function ensureEnvironment(
  projectId: string,
  env: DokployEnvironment,
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
    // A name deplo reserves (`pr-<n>`) or a duplicate: fall back to the project's
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

/** Every app currently filed under a project, for the shared-var link set. */
async function appIdsInProject(
  teamId: string,
  projectId: string,
): Promise<string[]> {
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(
      and(eq(appsTable.teamId, teamId), eq(appsTable.projectId, projectId)),
    );
  return rows.map((r) => r.id);
}

/* ---- applications and compose stacks -------------------------------- */

/**
 * One Dokploy application or compose stack → one deplo App, with its env vars,
 * config files, primary domain, extra domains, volumes, resource limits,
 * basic-auth users and crons.
 */
async function importAppService(
  c: DokployCredential,
  svc: SourceService,
  detail: DokployApplication & DokployCompose,
  name: string,
  home: {
    projectId: string;
    environmentId: string;
    serverId: string | undefined;
    buildServerId: string | null;
  },
  report: Report,
): Promise<string | null> {
  // Which Dokploy table it sat in. Whether it is a STACK here is decided below:
  // a compose service can turn out to be one app built from its own repository,
  // and importing that as a stack produces something that cannot deploy.
  let isCompose = svc.kind === "compose";

  // Already here? Leave it completely alone — a second pass must not re-write
  // someone's configuration behind their back.
  const existing = await getDb()
    .select({ id: appsTable.id, name: appsTable.name })
    .from(appsTable)
    .where(eq(appsTable.environmentId, home.environmentId));
  const match = existing.find(
    (a) => a.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (match) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "skipped",
      targetKind: "app",
      targetId: match.id,
      message: "An app with this name is already in this environment.",
    });
    return match.id;
  }

  const notes: string[] = [];

  // Env: the service's own blob, plus its build args, which deplo passes to the
  // build as ordinary variables (agent >= 1.9.0) rather than as a second channel.
  const envEntries = parseEnvBlob(detail.env);
  const argEntries = parseEnvBlob(
    (detail as DokployApplication).buildArgs,
  ).filter((a) => !envEntries.some((e) => e.key === a.key));
  // Every migrated variable comes across PLAIN, whatever it is called.
  const env = [...envEntries, ...argEntries].map((e) => ({
    ...e,
    type: "plain" as const,
  }));
  if (argEntries.length > 0)
    notes.push(
      `${argEntries.length} build argument(s) became environment variables - that is how Deplo passes values to a build.`,
    );
  const interpolated = envNeedsInterpolation(env);
  if (interpolated.length > 0)
    notes.push(
      `Deplo does not resolve Dokploy's \`\${{...}}\` templating - put the real values in: ${interpolated.join(", ")}.`,
    );

  // The compose text, read before anything that depends on the app's SHAPE: it
  // is what says whether this is a stack at all.
  let yamlText = "";
  if (isCompose) {
    const inline = (detail.composeFile ?? "").trim();
    yamlText = inline || (await getConvertedCompose(c, svc.id)) || "";
    if (!yamlText.trim()) {
      await report.add({
        sourceKind: svc.kind,
        sourceId: svc.id,
        sourceName: name,
        outcome: "failed",
        targetKind: "app",
        message:
          "The compose file is in a git repository and Dokploy would not hand over the resolved file. Create the app and paste the compose in.",
      });
      return null;
    }
  }

  /**
   * A compose service that is really one app built from its own repository.
   */
  const repoTarget = isCompose ? cloneTarget(detail) : null;
  const asRepoApp = repoTarget ? composeAsRepoApp(yamlText) : null;
  if (asRepoApp) isCompose = false;

  const domains = mapDomains(detail.domains, { isCompose });
  notes.push(...domains.notes);
  // The app's own address wins the primary slot over a temporary one, whatever order
  // the source kept them in: a throwaway host is first over there simply because
  // Dokploy minted it first, and promoting it here would demote the name people
  // actually type to a secondary row.
  const primary =
    domains.value.find((d) => !d.generated) ?? domains.value[0] ?? null;
  const mounts = mapMounts(detail.mounts, { isCompose });
  notes.push(...mounts.notes);

  // What createApp needs to know about the source.
  let source: Parameters<typeof createApp>[0]["source"] = "upload";
  let repo: Parameters<typeof createApp>[0]["repo"] = null;
  let dockerImage: string | null = null;
  let compose: string | null = null;
  const build: Partial<BuildConfig> = {};

  if (asRepoApp && repoTarget) {
    source = repoTarget.provider === "github" ? "github" : "git";
    repo = repoTarget;
    // `build: .` in compose IS a Dockerfile build - the context dir's own
    // Dockerfile unless the block names another. Nothing here has to guess.
    build.buildMethod = "dockerfile";
    build.methodSettings = {
      dockerfilePath: asRepoApp.dockerfilePath ?? "Dockerfile",
      ...(asRepoApp.dockerContextPath
        ? { dockerContextPath: asRepoApp.dockerContextPath }
        : {}),
      ...(asRepoApp.dockerBuildStage
        ? { dockerBuildStage: asRepoApp.dockerBuildStage }
        : {}),
    };
    notes.push(
      `On Dokploy this was a compose file in ${repoTarget.repo}, and all it did was build that repository and run it - so it came across as an app built from ${repoTarget.repo}, not as a stack. Pushing to ${repoTarget.branch} deploys it.`,
    );
  } else if (isCompose) {
    source = "compose";
    const inline = (detail.composeFile ?? "").trim();
    if (!inline)
      notes.push(
        "The compose file is kept inline from now on, so changes in the repository will not follow.",
      );
    const adapted = adaptComposeForDeplo(yamlText);
    // An `env_file` naming a file this stack does not carry is the other platform's own
    // env file under its own name (`stack.env` and friends).
    const retargeted = retargetPlatformEnvFiles(
      adapted.compose,
      mounts.value.files.map((f) => f.filePath),
    );
    compose = retargeted.compose;
    notes.push(...adapted.changes, ...retargeted.changes);
    notes.push(...composeAdvice(compose));
    // A compose file that parses to nothing deployable still comes across (its
    // variables, domains and mounts are the part that takes an afternoon to retype),
    // but it used to do so without a word - and the app it makes can never deploy.
    const builders = composeBuildServices(compose);
    if (builders.length > 0)
      notes.push(
        `${builders.join(", ")} ${builders.length === 1 ? "builds" : "build"} from source, and Deplo has no repository for this stack - only the compose file came over. Give ${builders.length === 1 ? "it an" : "them"} image, or split ${builders.length === 1 ? "it" : "them"} out into ${builders.length === 1 ? "its" : "their"} own app built from the repository.`,
      );
    const services = composeServiceCount(compose);
    if (services === null)
      notes.push(
        "Its compose file is not valid YAML, so it came across exactly as it is - nothing here rewrote it. Fix it under Compose before deploying.",
      );
    else if (services === 0)
      notes.push(
        "Its compose file declares no services, so there is nothing to deploy yet. Add them under Compose.",
      );
    // An `env_file` the author wrote resolves inside the stack's own directory, which
    // is a thing the AGENT does - and an older one on this host does not, so the stack
    // would come up looking for a file that is not there.
    if (/^\s*env_file\s*:/m.test(compose) && home.serverId) {
      const { serverSupports, COMPOSE_PROJECTDIR_CAPABILITY } =
        await import("../infra/agent-client");
      if (!(await serverSupports(home.serverId, COMPOSE_PROJECTDIR_CAPABILITY)))
        notes.push(
          "Its compose file names an `env_file`, which needs a newer agent on this server than the one running there. Update the server's agent under Servers before deploying.",
        );
    }
    // The host ports the stack binds, checked against the machine it is landing on.
    const wantedPorts = composeHostPorts(compose);
    if (wantedPorts.length > 0 && home.serverId && (await canExposePorts())) {
      try {
        const { hostPortsInUse } = await import("./databases");
        const probe = await hostPortsInUse(home.serverId, wantedPorts);
        if (probe.checked && probe.inUse.length > 0)
          notes.push(
            `It publishes ${probe.inUse.join(", ")} on the host, and ${probe.inUse.length === 1 ? "that port is" : "those ports are"} already taken on this server - the stack will not start until you change ${probe.inUse.length === 1 ? "it" : "them"} under Compose.`,
          );
      } catch {
        /* A probe is a courtesy: never let it fail an import. */
      }
    }
    if (detail.isolatedDeployment)
      notes.push(
        "Dokploy isolates this stack's network and volume names. Deplo does that for every stack - check the service names it talks to.",
      );
  } else {
    const app = detail as DokployApplication;
    const mapped = mapSource(app);
    notes.push(...mapped.notes);
    if (mapped.value.kind === "git") {
      source = mapped.value.repo.provider === "github" ? "github" : "git";
      repo = mapped.value.repo;
    } else if (mapped.value.kind === "docker-image") {
      source = "docker-image";
      dockerImage = mapped.value.image;
    } else {
      // Nothing deployable came across (an uploaded archive, an image reference
      // deplo will not take). The app is still worth creating: its variables,
      // domains, mounts and limits are the part that takes an afternoon to retype.
      source = "upload";
      notes.push(
        "Set the source under the app's Source settings before deploying.",
      );
    }
    const mappedBuild = mapBuildSettings(app);
    notes.push(...mappedBuild.notes);
    Object.assign(build, mappedBuild.value);
    notes.push(...portNotes(app));
    notes.push(...unsupportedNotes(app));
  }

  // Routing port: Dokploy keeps it on the domain, deplo on the build config (a
  // domain may still override it). Taking the primary domain's port keeps the two
  // consistent from the start.
  if (primary?.port) build.port = primary.port;

  // Claiming a hostname needs `manage_domains`, and an import must not turn a missing
  // permission into a failed app: without it the app comes across on a generated host
  // and the report says which names were left behind, exactly like the extra domains
  // below.
  const mayClaimHosts = await hasCapability("manage_domains");
  // Only a REAL hostname is a claim the permission gates. A throwaway address is
  // re-hosted onto one of Deplo's own either way (`addImportedDomains`), so
  // naming it here would blame a permission for something it never blocked.
  const claimed = domains.value.filter((d) => !d.generated);
  if (!mayClaimHosts && claimed.length > 0)
    notes.push(
      `You don't have permission to manage domains, so ${claimed
        .map((d) => d.host)
        .join(", ")} came across on a generated address instead.`,
    );

  const created = await createApp({
    name,
    source,
    repo,
    dockerImage,
    compose,
    env,
    serverId: home.serverId,
    buildServerId: home.buildServerId,
    projectId: home.projectId,
    environmentId: home.environmentId,
    build,
    autoDeploy: detail.autoDeploy ?? true,
    // A throwaway host is never asked for: it names the SOURCE's machine, and
    // createApp would either refuse it or point this app at the old box.
    autoDomain:
      mayClaimHosts && primary && !primary.generated ? primary.host : null,
    // Two apps of one team may share a hostname on different paths, and the
    // import is where that shape arrives - so the path is claimed with the name.
    autoDomainPath: primary?.pathPrefix || null,
    // A service that answered on NOTHING over there gets nothing here.
    noAutoDomain: domains.value.length === 0,
    composeService: isCompose ? (primary?.service ?? null) : null,
    composePort: isCompose ? (primary?.port ?? null) : null,
    // `app_mounts` is materialised by the compose deploy and by nothing else, so
    // a single-image app's config files are written below instead - storing them
    // here would be a row nobody ever turns back into a file.
    mounts:
      isCompose && mounts.value.files.length > 0 ? mounts.value.files : null,
    // The icon comes across with everything else.
    logo: mapLogo(detail.icon),
    deploy: false,
  });

  await report.add({
    sourceKind: svc.kind,
    sourceId: svc.id,
    sourceName: name,
    outcome: "created",
    targetKind: "app",
    targetId: created.id,
    message: `${env.length} variable(s), ${mounts.value.files.length} config file(s).`,
  });
  const target = { kind: "app", id: created.id };

  // EVERY address the app answered on over there has to be an address it answers on
  // here.
  const rehosted = new Map<string, string>();
  if (domains.value.length === 0)
    notes.push(
      "It answered on no address on Dokploy, so it arrives with none here either. Add one under Domains if it should be reachable from outside.",
    );
  if (primary) {
    const landed = await getDb()
      .select({
        id: domainsTable.id,
        name: domainsTable.name,
        certProvider: domainsTable.certProvider,
        pathPrefix: domainsTable.pathPrefix,
        stripPrefix: domainsTable.stripPrefix,
        entrypoint: domainsTable.entrypoint,
      })
      .from(domainsTable)
      .where(
        and(
          eq(domainsTable.appId, created.id),
          eq(domainsTable.isPrimary, true),
        ),
      );
    const row = landed[0];
    if (row && row.name.toLowerCase() !== primary.host) {
      // The address changed - because it was a throwaway, or because the real one was
      // taken.
      await applyImportedRoute(row.id, importedRoute(primary));
      rehosted.set(primary.host, row.name);
      notes.push(
        primary.generated
          ? `${primary.host} was Dokploy's own temporary address, so this app answers on ${row.name} here - same port, same route.`
          : `${primary.host} could not be taken, so the app answers on ${row.name} instead.`,
      );
    } else if (row) {
      // createApp mints the primary domain itself and knows only its NAME, so everything
      // else about the route has to be applied afterwards.
      const patch: DomainPatch = {};
      if (row.certProvider !== primary.certProvider)
        patch.certProvider = primary.certProvider;
      if ((row.pathPrefix ?? "") !== primary.pathPrefix)
        patch.pathPrefix = primary.pathPrefix;
      if (primary.pathPrefix && !!row.stripPrefix !== primary.stripPrefix)
        patch.stripPrefix = primary.stripPrefix;
      if ((row.entrypoint ?? "") !== primary.entrypoint)
        patch.entrypoint = primary.entrypoint;
      if (Object.keys(patch).length > 0)
        try {
          await updateDomain(row.id, patch);
        } catch (e) {
          notes.push(
            `${primary.host} did not keep its route (${primary.pathPrefix || "/"}, ${primary.certProvider}): ${e instanceof Error ? e.message : "refused"}. Set it under Domains.`,
          );
        }
    }
  }

  const rest = domains.value.filter((d) => d !== primary);
  // A real hostname is asked for first. One that cannot be taken - another team here
  // already serves it, or this member may not claim names - is NOT dropped either: it
  // joins the re-hosting below, for the same reason a throwaway does.
  const refused: MappedDomain[] = [];
  for (const d of rest.filter((d) => !d.generated))
    if (!(await addExtraDomain(created.id, d, notes))) refused.push(d);

  const toRehost = [...rest.filter((d) => d.generated), ...refused];
  if (toRehost.length > 0) {
    try {
      const server = await getServerById(created.serverId);
      const landed = await addImportedDomains(
        created.id,
        toRehost.map(importedRoute),
        {
          slug: created.slug,
          ip: resolveServerIp(server ?? undefined),
          seed: rehosted,
        },
      );
      const wasThrowaway = new Set(
        rest.filter((d) => d.generated).map((d) => d.host),
      );
      for (const [source, host] of landed)
        if (!rehosted.has(source)) {
          rehosted.set(source, host);
          notes.push(
            wasThrowaway.has(source)
              ? `${source} was Dokploy's own temporary address, so it comes across as ${host} here - same port, same route.`
              : `${source} answers on ${host} here instead - same port, same route. Point it at this server and add it under Domains to use the real name.`,
          );
        }
    } catch (e) {
      notes.push(
        `The temporary addresses this app answered on were not recreated: ${
          e instanceof Error ? e.message : "refused"
        }. Add a domain under Domains.`,
      );
    }
  }

  // The one place a re-hosted address cannot be fixed from out here: INSIDE the app's
  // own data.
  if (rehosted.size > 0) {
    const landedOn = [...new Set(rehosted.values())].join(", ");
    notes.push(
      `If this app stores its own address (Nextcloud's trusted_domains, WordPress's siteurl), the copied data still has the old one - open the app's Console and set it to ${landedOn}.`,
    );
  }

  // An address that could not come across is a DEAD address, and the app is usually
  // still carrying it in its own configuration: `NEXTCLOUD_DOMAIN`, `SITE_URL`, a
  // CORS origin, a callback URL.
  if (rehosted.size > 0) {
    const rewritten = env.map((e) => ({
      key: e.key,
      value: rewriteHosts(e.value, rehosted),
    }));
    const touched = rewritten
      .filter((r, i) => r.value !== env[i]!.value)
      .map((r) => r.key);
    if (touched.length > 0) {
      try {
        await setAppEnv(created.id, rewritten);
        notes.push(
          `${touched.join(", ")} named the old address, so ${
            touched.length === 1 ? "it now names" : "they now name"
          } the new one.`,
        );
      } catch (e) {
        notes.push(
          `${touched.join(", ")} still name the old address (${
            e instanceof Error ? e.message : "refused"
          }) - update them under Variables.`,
        );
      }
    }
  }

  // Every config file is written into the app's Files here and now - the same write
  // the Storage editor makes - for two different reasons.
  const unwritten = new Set<string>();
  for (const f of mounts.value.files) {
    try {
      await writeAppFile(created.id, f.filePath, f.content);
    } catch (e) {
      unwritten.add(f.filePath);
      // Only worth saying for a single-image app: there, a file that was not
      // written is a file that is GONE, and its mount is dropped below with it.
      // The stack's own deploy will write the compose one on its own.
      if (!isCompose)
        notes.push(
          `${f.filePath} could not be written into this app's Files: ${
            e instanceof Error ? e.message : "refused"
          }. Add it under Files and mount it under Storage.`,
        );
    }
  }

  let volumes = mounts.value.volumes.filter(
    (v) => !(v.type === "app" && unwritten.has(v.projectPath ?? "")),
  );

  // A compose service that came across as an APP keeps its storage: its volumes were
  // declared in the compose file, not in Dokploy's mounts, so nothing above saw them
  // - and without them the app arrives with nowhere for the data cutover to put the
  // bytes.
  if (asRepoApp)
    for (const v of composeVolumeMounts(yamlText))
      volumes.push({
        type: "named",
        name: volumeLabel(v.name, "data"),
        mountPath: v.mountPath,
        readOnly: false,
      });

  // A compose stack's config file is mounted by the stack's OWN yaml, so nothing in
  // Storage described it and the Storage page - the one place a person looks for
  // "what files does this app have" - showed an empty list for an app that
  // demonstrably had one.
  if (isCompose && compose) {
    const bindings = composeFileBindings(compose);
    for (const f of mounts.value.files) {
      // Unlike a single-image app's File entry, this row does not depend on the
      // write above having landed: the file is in `app_mounts` too, and the
      // agent writes it from there on every bring-up.
      const bound = bindings.find((b) => b.filePath === f.filePath);
      if (!bound) continue; // in the files dir but mounted nowhere: nothing to show
      volumes.push({
        type: "app",
        name: volumeLabel(f.filePath, "file"),
        projectPath: f.filePath,
        mountPath: bound.mountPath,
        service: bound.service,
        readOnly: bound.readOnly,
      });
    }
  }
  // A host bind needs the host-volumes grant, and setAppVolumes refuses the WHOLE
  // set over one of them - which used to drop the app's named volumes with it.
  // Leave the bind behind, keep the storage that needs no grant, and say so.
  if (
    volumes.some((v) => v.type === "host") &&
    !(await canMountHostVolumes())
  ) {
    notes.push(
      `You don't have permission to mount host folders, so ${volumes
        .filter((v) => v.type === "host")
        .map((v) => v.hostPath)
        .join(
          ", ",
        )} did not come across. An admin turns it on with "Bind server folders" in Settings → Users.`,
    );
    volumes = volumes.filter((v) => v.type !== "host");
  }
  // Same shape as the grant filter above, and for the same measured reason:
  // `setAppVolumes` writes the whole set or nothing, so ONE entry it will not take
  // used to leave the app with NO storage at all.
  const refusedMounts: string[] = [];
  volumes = volumes.filter((v) => {
    const path = (v.mountPath ?? "").trim().replace(/\/+$/, "");
    // The relaxed rule an import gets: reserved only AS the path itself.
    if (!path || !reservedMountPath(path, "app")) return true;
    refusedMounts.push(path);
    return false;
  });
  if (refusedMounts.length > 0)
    notes.push(
      `${refusedMounts.join(", ")} ${refusedMounts.length === 1 ? "is a path" : "are paths"} the container runtime owns, so ${refusedMounts.length === 1 ? "it" : "they"} did not come across. Everything else this app mounts did.`,
    );
  if (volumes.length > 0) {
    try {
      await setAppVolumes(
        created.id,
        volumes.map((v) => ({ ...v, id: newId("vol") }) as VolumeMount),
        { imported: true },
      );
    } catch (e) {
      notes.push(
        `Volumes were not imported: ${e instanceof Error ? e.message : "refused"}. Add them under Storage.`,
      );
    }
  }

  const resources = mapResources(detail);
  notes.push(...resources.notes);
  if (resources.value) {
    try {
      await updateAppResources(created.id, resources.value);
    } catch (e) {
      notes.push(
        `Resource limits were not imported: ${e instanceof Error ? e.message : "refused"}.`,
      );
    }
  }

  // The credential comes across AS IT IS. Measured: a code-server arrived online and
  // open because "CoderPass123" has no special character.
  const security = (detail as DokployApplication).security ?? [];
  for (const s of security) {
    try {
      await addBasicAuthUser(created.id, s.username, s.password, {
        imported: true,
      });
    } catch (e) {
      notes.push(
        `Basic-auth user "${s.username}" was not imported: ${e instanceof Error ? e.message : "refused"}. This app answers WITHOUT that password now.`,
      );
    }
  }
  if (security.length > 0)
    notes.push(
      `${security.length === 1 ? "Its basic-auth password came" : `Its ${security.length} basic-auth passwords came`} across unchanged, so the app is protected exactly as it was. ${security.length === 1 ? "It was" : "They were"} never checked against Deplo's password rules - rotate ${security.length === 1 ? "it" : "them"} under Access when the migration is done.`,
    );

  // Preview deployments.
  if (!isCompose) {
    const app = detail as DokployApplication;
    if (app.isPreviewDeploymentsActive) {
      try {
        const { setAppPreviewSettings } = await import("./previews");
        await setAppPreviewSettings(created.id, {
          enabled: true,
          port: app.previewPort ?? null,
          maxActive:
            typeof app.previewLimit === "number" && app.previewLimit > 0
              ? Math.min(app.previewLimit, 50)
              : null,
        });
      } catch (e) {
        notes.push(
          `Preview deployments were on over there but did not come across: ${e instanceof Error ? e.message : "refused"}. Turn them on under Previews.`,
        );
      }
    }
  }

  await importCrons(
    c,
    isCompose ? "compose" : "application",
    svc.id,
    created.id,
    notes,
  );

  await report.notes(svc.kind, name, notes, target, svc.id);
  return created.id;
}

/**
 * Every occurrence of a re-hosted address, replaced by the one it became. A plain
 * substring swap, because that is how these values are shaped: the host sits
 * inside a URL, a comma-separated list, a connection string.
 */
function rewriteHosts(value: string, hosts: Map<string, string>): string {
  let out = value;
  for (const [from, to] of [...hosts].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    if (!from) continue;
    out = out.replace(
      new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      to,
    );
  }
  return out;
}

/** A mapped domain as the domain writers take it: the route, plus where it came
 *  from. One function so the primary and the extras can never describe the same
 *  source domain differently. */
function importedRoute(d: MappedDomain): ImportedRoute {
  return {
    sourceHost: d.host,
    port: d.port,
    pathPrefix: d.pathPrefix,
    stripPrefix: d.stripPrefix,
    certProvider: d.certProvider,
    entrypoint: d.entrypoint,
    service: d.service,
  };
}

/** An extra (non-primary) hostname, with everything Dokploy knew about it. */
async function addExtraDomain(
  appId: string,
  d: MappedDomain,
  notes: string[],
): Promise<boolean> {
  try {
    await addDomain(appId, d.host, {
      port: d.port,
      pathPrefix: d.pathPrefix,
      stripPrefix: d.stripPrefix,
      certProvider: d.certProvider,
      entrypoint: d.entrypoint,
      service: d.service ?? undefined,
    });
    return true;
  } catch (e) {
    notes.push(
      `${d.host} could not be taken here: ${e instanceof Error ? e.message : "refused"}.`,
    );
    return false;
  }
}

/** Dokploy's schedules for one service → deplo cron jobs. */
async function importCrons(
  c: DokployCredential,
  scheduleType: "application" | "compose",
  sourceId: string,
  appId: string,
  notes: string[],
): Promise<void> {
  for (const s of await listSchedules(c, scheduleType, sourceId)) {
    const command = (s.command ?? s.script ?? "").trim();
    if (!command) {
      notes.push(`Cron "${s.name}" has no command on Dokploy - not imported.`);
      continue;
    }
    try {
      await createCronJob("app", appId, {
        name: s.name,
        schedule: s.cronExpression,
        command,
        service: s.serviceName?.trim() || null,
        enabled: s.enabled !== false,
      });
    } catch (e) {
      notes.push(
        `Cron "${s.name}" was not imported: ${e instanceof Error ? e.message : "refused"}.`,
      );
    }
  }
}

/* ---- databases ------------------------------------------------------- */

/**
 * One Dokploy database → one deplo Database.
 */
async function importDatabaseService(
  c: DokployCredential,
  svc: SourceService,
  row: DokployDatabase,
  name: string,
  opts: {
    serverId: string | undefined;
    /** Undefined keeps the source's port, null publishes none, a number overrides. */
    exposedPort?: number | null;
    mayExposePorts: boolean;
    sourceIsTargetHost: boolean;
  },
  report: Report,
): Promise<void> {
  const { serverId } = opts;
  const mapped = mapDatabase(svc.kind as DokployDbKind, { ...row, name });
  const notes = [...mapped.notes];
  if (!mapped.value) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "unsupported",
      targetKind: "database",
      message: notes.join(" ") || "Deplo has no such engine.",
    });
    return;
  }
  const spec = mapped.value;

  const clash = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.teamId, await requireActiveTeamId()),
        sql`lower(${databasesTable.name}) = ${spec.name.trim().toLowerCase()}`,
      ),
    );
  if (clash.length > 0) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "skipped",
      targetKind: "database",
      targetId: clash[0].id,
      message: "A database with this name is already in this team.",
    });
    return;
  }

  // The password is carried over on purpose (see mapDatabase), and as a GENERATED
  // credential: another platform's random token is not something a person chose, so
  // deplo's account policy does not apply to it.
  const base = {
    name: spec.name,
    type: spec.type,
    version: spec.version,
    serverId,
    username: spec.username ?? undefined,
    dbName: spec.dbName ?? undefined,
    // The source's image, pinned at CREATE so the first provision already runs it.
    customImage: spec.customImage,
  };
  const withPassword = {
    ...base,
    password: spec.password ?? undefined,
    passwordIsGenerated: true,
  };

  // What this database publishes here. The review may have said otherwise - a
  // different port, or none at all - and without the grant nothing can be
  // published whatever anyone chose.
  const sourcePort = spec.exposedPort ?? null;
  const chosenPort =
    opts.exposedPort !== undefined ? opts.exposedPort : sourcePort;
  if (!opts.mayExposePorts && chosenPort != null)
    notes.push(
      `Port ${chosenPort} was not published: you don't have permission to publish ports.`,
    );
  else if (chosenPort == null && sourcePort != null)
    notes.push(
      `Port ${sourcePort} was not published, as chosen during the import.`,
    );
  const publishPort = opts.mayExposePorts ? chosenPort : null;
  const withPort =
    publishPort != null
      ? { exposedPublicly: true, exposedPort: publishPort }
      : {};

  const portNote = (why: string) =>
    `Port ${publishPort} was not published (${why}). Publish it from the database's Connection settings once that port is free.`;

  // The FIRST failure is the one worth reporting: every later attempt is Deplo
  // giving something up, so their errors describe the compromise, not the cause.
  let firstError = "";
  const attempt = async (payload: Parameters<typeof createDatabase>[0]) => {
    try {
      return await createDatabase(payload);
    } catch (e) {
      if (!firstError) firstError = e instanceof Error ? e.message : "refused";
      return null;
    }
  };

  let created = await attempt({ ...withPassword, ...withPort });

  // The port is held by the very container we are importing.
  if (!created && publishPort != null && opts.sourceIsTargetHost) {
    try {
      await stopService(c, svc.kind, svc.id);
      created = await attempt({ ...withPassword, ...withPort });
    } catch {
      /* Dokploy would not stop it; the data phase tries again and says so. */
    }
  }

  // Two things can still fail here, and the report must name the one that did: the
  // port is held by something that is not ours, or the password cannot ride inside a
  // connection string.
  if (!created && publishPort != null) {
    created = await attempt(withPassword);
    if (created) notes.push(portNote(firstError));
  }
  if (!created) {
    created = await attempt(base);
    if (created) {
      if (publishPort != null) notes.push(portNote(firstError));
      notes.push(
        `Password refused (${firstError}), so Deplo made a new one - the imported connection strings still hold the old.`,
      );
    }
  }
  if (!created) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "failed",
      targetKind: "database",
      message: firstError || "Could not create the database.",
    });
    return;
  }

  // The start command and the resource caps, both of which Deplo stores on a database
  // and neither of which the import was writing: a Postgres tuned with `-c
  // shared_buffers=1GB` arrived untuned, and one capped at 1 GB / 0.5 CPU arrived
  // uncapped - free to take the whole host from every other tenant.
  if (spec.command) {
    try {
      const { updateDatabaseImage } = await import("./databases");
      await updateDatabaseImage(created.id, { customCommand: spec.command });
    } catch (e) {
      notes.push(
        `Its start command was not imported: ${e instanceof Error ? e.message : "refused"}. Set it under Settings -> Advanced.`,
      );
    }
  }
  const dbResources = mapResources(row);
  notes.push(...dbResources.notes);
  if (dbResources.value) {
    try {
      const { updateDatabaseResources } = await import("./databases");
      await updateDatabaseResources(created.id, dbResources.value);
    } catch (e) {
      notes.push(
        `Its memory and CPU limits were not imported: ${e instanceof Error ? e.message : "refused"}. Set them under Settings -> Resources.`,
      );
    }
  }

  // The engine's config files. AFTER the create, because they are a whole-set replace
  // on an existing database - and before the report, so a refusal is one of the notes
  // rather than a silent gap.
  if (spec.mounts.length > 0) {
    try {
      await setDatabaseMounts(created.id, spec.mounts);
    } catch (e) {
      notes.push(
        `The engine's config files were not imported: ${
          e instanceof Error ? e.message : "refused"
        }. Add them under Settings -> Advanced.`,
      );
    }
  }

  // Said out loud, because every connection string the import just brought over
  // still spells out the old one.
  if (publishPort != null && sourcePort != null && publishPort !== sourcePort)
    notes.push(
      `Published on ${publishPort} instead of ${sourcePort} - update the connection strings that name the old port.`,
    );

  await report.add({
    sourceKind: svc.kind,
    sourceId: svc.id,
    sourceName: name,
    outcome: "created",
    targetKind: "database",
    targetId: created.id,
  });

  // Says what happens NEXT, in this same import. "Restore your data" read as "go
  // find a dump and do it yourself", which is how someone concludes the import left
  // them with an empty database and no way to move the old one.
  notes.push(
    `Empty until the data copy runs, a moment from now in this same import. It answers as "${created.host}", not "${row.appName}", so update the connection strings.`,
  );
  await report.notes(
    svc.kind,
    name,
    notes,
    { kind: "database", id: created.id },
    svc.id,
  );
}

/* ---- project / environment level variables --------------------------- */

/**
 * A Dokploy project's or environment's own env blob → a deplo shared variable per
 * key, scoped there AND linked to the apps that were in it.
 */
async function importSharedVars(
  blob: string | null | undefined,
  opts: {
    teamId: string;
    label: string;
    environmentIds: string[];
    projectIds: string[];
    appIds: string[];
    report: Report;
  },
): Promise<void> {
  const entries = parseEnvBlob(blob);
  if (entries.length === 0) return;

  // Same rule as everything else on a re-run: a key that is already here is left
  // exactly as it is.
  const already = new Set(
    (
      await getDb()
        .select({ key: sharedVarsTable.key })
        .from(sharedVarsTable)
        .where(eq(sharedVarsTable.teamId, opts.teamId))
    ).map((r) => r.key),
  );

  for (const { key, value } of entries) {
    if (already.has(key)) {
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "skipped",
        targetKind: "shared-var",
        message: "A shared variable with this name is already in this team.",
      });
      continue;
    }
    try {
      await saveSharedVar({
        key,
        value,
        // Plain, for the same reason the app's own variables are - see the
        // service import.
        type: "plain",
        teamWide: false,
        environmentIds: opts.environmentIds,
        projectIds: opts.projectIds,
        appIds: opts.appIds,
      });
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "created",
        targetKind: "shared-var",
        message:
          opts.appIds.length === 0
            ? "Nothing is linked to it yet - no app was imported into this scope."
            : null,
      });
    } catch (e) {
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "failed",
        targetKind: "shared-var",
        message:
          e instanceof Error ? e.message : "Could not create the variable.",
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Members                                                            */
/* ------------------------------------------------------------------ */

/**
 * Bring the Dokploy organization's people over. Passwords are not migratable in
 * either direction: Dokploy's API never exposes them and its hashes are not
 * deplo's.
 */
export async function importDokployMembers(
  input: ConnectInput & { runId: string },
): Promise<DokployInvite[]> {
  const { teamId } = await assertImportGate();
  await requireInstanceAdmin();
  const c = await credentialFor(input);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const report = new Report(input.runId).at("Members");
  const people = await planMembers(c, teamId);
  const out: DokployInvite[] = [];

  const accounts = new Map<string, string>();
  if (people.length > 0)
    for (const a of await getDb()
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(
        inArray(
          sql`lower(${usersTable.email})`,
          people.map((p) => p.email),
        ),
      ))
      accounts.set(a.email.toLowerCase(), a.id);

  for (const p of people) {
    const roleNote =
      p.sourceRole && p.sourceRole !== "member"
        ? ` Was ${p.sourceRole} on Dokploy - promote them in Members if that should carry over.`
        : "";

    if (p.inTeam) {
      const entry = {
        ...p,
        link: null,
        outcome: "skipped",
        message: "Already a member of this team.",
      };
      out.push(entry);
      await report.add({
        sourceKind: "member",
        sourceName: p.email,
        outcome: "skipped",
        message: entry.message,
      });
      continue;
    }

    const userId = accounts.get(p.email);
    try {
      if (userId) {
        await addExistingMember({ userId, role: "member" });
        out.push({
          ...p,
          link: null,
          outcome: "created",
          message: `Added to the team as a member.${roleNote}`,
        });
        await report.add({
          sourceKind: "member",
          sourceName: p.email,
          outcome: "created",
          targetKind: "member",
          targetId: userId,
          message: `Added to the team as a member.${roleNote}`,
        });
      } else {
        const { link } = await mintRegistrationLink({
          mode: "existing_teams",
          teamAssignments: [{ teamId, role: "member" }],
        });
        out.push({
          ...p,
          link,
          outcome: "manual",
          message: `Send them this link to create their account.${roleNote}`,
        });
        await report.add({
          sourceKind: "member",
          sourceName: p.email,
          outcome: "manual",
          targetKind: "registration-link",
          message: `A registration link was created for ${p.email}.${roleNote}`,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not be invited.";
      out.push({ ...p, link: null, outcome: "failed", message });
      await report.add({
        sourceKind: "member",
        sourceName: p.email,
        outcome: "failed",
        message,
      });
    }
  }

  await refreshCounts(input.runId, teamId);
  return out;
}

/* ------------------------------------------------------------------ */
/* History                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Undo                                                               */
/* ------------------------------------------------------------------ */

/** The message off whatever a delete threw, without leaking a stack. */
function revertError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Stop a migration, which means UNDO it - the whole thing, every time. Dokploy is
 * left as the migration left it - services it stopped over there stay stopped,
 * which the wizard says before it asks.
 */
export async function stopDokployImport(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  await getDb()
    .update(runsTable)
    .set({ status: "stopped", finishedAt: nowIso() })
    .where(
      and(
        eq(runsTable.id, runId),
        eq(runsTable.teamId, teamId),
        eq(runsTable.status, "running"),
      ),
    );
  await undoDokployImport(runId);
}

/**
 * Take a run back out whole: what it created HERE, and the agent Deplo put over
 * THERE to read it. The uninstall is FORCED past its usual guard.
 */
export async function undoDokployImport(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  await releaseMigrating(runId);
  await revertDokployImport(runId);
  await removeMigrationSources(runId, teamId, { force: true });
  await refreshCounts(runId, teamId);
}

/** What a revert managed to take back out, and what it could not. */
export interface RevertResultDTO {
  apps: number;
  databases: number;
  environments: number;
  projects: number;
  sharedVars: number;
  /** One line per thing that is still here, and why. */
  failed: string[];
}

/**
 * Take a migration back out of Deplo. The wizard says so before it runs. That
 * refusal arrives here as a `failed` line rather than as an exception, because one
 * unreachable host must not strand the other ten objects.
 */
/** Undoing a migration deletes the very rows it marked, so it is exempt too. */
export async function revertDokployImport(
  runId: string,
): Promise<RevertResultDTO> {
  return runAsMigration(() => runRevertDokployImport(runId));
}

async function runRevertDokployImport(runId: string): Promise<RevertResultDTO> {
  const { teamId } = await assertImportGate();
  if (!(await ownRun(runId, teamId))) throw new Error("Migration not found");

  const rows = await getDb()
    .select({
      path: itemsTable.path,
      sourceName: itemsTable.sourceName,
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
    })
    .from(itemsTable)
    .where(and(eq(itemsTable.runId, runId), eq(itemsTable.outcome, "created")));

  const idsOf = (kind: string) => [
    ...new Set(
      rows
        .filter((r) => r.targetKind === kind && r.targetId)
        .map((r) => r.targetId!),
    ),
  ];
  const nameOf = (id: string) =>
    rows.find((r) => r.targetId === id)?.sourceName ?? id;

  const failed: string[] = [];
  const result: RevertResultDTO = {
    apps: 0,
    databases: 0,
    environments: 0,
    projects: 0,
    sharedVars: 0,
    failed,
  };

  // ---- apps ---------------------------------------------------------
  // One bulk call rather than N: it tears the stacks down with bounded
  // concurrency, so reverting twenty apps cannot flood one host's agent.
  const appIds = idsOf("app");
  if (appIds.length > 0) {
    const { deleteApps } = await import("./apps");
    try {
      result.apps = await deleteApps(appIds);
    } catch (e) {
      failed.push(`Apps: ${revertError(e)}`);
    }
  }

  // ---- databases ----------------------------------------------------
  // One at a time, because each one holds its own lifecycle lock and its own
  // proof that the volume is gone.
  const { deleteDatabase } = await import("./databases");
  for (const id of idsOf("database")) {
    try {
      await deleteDatabase(id);
      result.databases += 1;
    } catch (e) {
      failed.push(`${nameOf(id)}: ${revertError(e)}`);
    }
  }

  // ---- projects the run made ----------------------------------------
  // Their environments go with them (the FK cascades), which is why the
  // environment pass below only has to look at the others.
  const projectIds = idsOf("project");
  const { deleteProject } = await import("./projects");
  for (const id of projectIds) {
    try {
      await deleteProject(id);
      result.projects += 1;
    } catch (e) {
      failed.push(`${nameOf(id)}: ${revertError(e)}`);
    }
  }

  // ---- the team's shared variables the run added --------------------- Matched by
  // KEY, not by id: the report line for a shared variable carries no target id, and
  // it does not need one - a key that already existed is recorded `skipped`, so a
  // `created` line can only be this run's own.
  const varKeys = new Set(
    rows.filter((r) => r.targetKind === "shared-var").map((r) => r.sourceName),
  );
  if (varKeys.size > 0) {
    const { deleteSharedVar, listSharedVars } = await import("./shared-vars");
    try {
      for (const v of await listSharedVars()) {
        if (!varKeys.has(v.key)) continue;
        try {
          await deleteSharedVar(v.id);
          result.sharedVars += 1;
        } catch (e) {
          failed.push(`${v.key}: ${revertError(e)}`);
        }
      }
    } catch (e) {
      failed.push(`Shared variables: ${revertError(e)}`);
    }
  }

  // ---- environments added to a project that was already here --------
  const { deleteEnvironment } = await import("./environments");
  for (const id of idsOf("environment")) {
    // One under a project this revert just removed went with it.
    if (await environmentIsGone(id)) continue;
    try {
      await deleteEnvironment(id);
      result.environments += 1;
    } catch (e) {
      failed.push(`${nameOf(id)}: ${revertError(e)}`);
    }
  }

  // What could NOT be taken back out goes into the run's own log, which is the only
  // place anybody looks afterwards.
  for (const line of failed) {
    const [head, ...rest] = line.split(": ");
    await appendRunItem(runId, {
      path: `Undo / ${head}`,
      sourceKind: "undo",
      sourceName: head,
      outcome: "failed",
      message: rest.join(": ") || "could not be removed",
    });
  }

  // The run stays in History - what happened is still what happened - but it says out
  // loud that it was taken back out, so nobody reads "12 created" as twelve apps that
  // exist.
  await getDb()
    .update(runsTable)
    .set({ status: "reverted", finishedAt: nowIso(), reportSeenAt: nowIso() })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  publishMigrationChanged();

  // Same `project` type the import itself writes under, so the two halves of
  // one migration sit together in the trail.
  await recordActivity(
    "project",
    `Reverted a migration: removed ${result.apps} app(s), ` +
      `${result.databases} database(s) and ${result.projects} project(s)`,
    (await getCurrentUser())?.name ?? "Someone",
    null,
    teamId,
  );

  return result;
}

/** Has this environment already gone with its project? */
async function environmentIsGone(id: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: environmentsTable.id })
    .from(environmentsTable)
    .where(eq(environmentsTable.id, id));
  return rows.length === 0;
}

/**
 * The run the wizard should OPEN on, or null for an empty connect form.
 */
export async function resumableDokployImport(): Promise<ImportRunDTO | null> {
  const teamId = await requireActiveTeamId();
  const user = await getCurrentUser();
  if (!user) return null;
  const [row] = await getDb()
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.teamId, teamId),
        isNull(runsTable.reportSeenAt),
        or(eq(runsTable.actorUserId, user.id), eq(runsTable.status, "running")),
      ),
    )
    .orderBy(desc(runsTable.seq))
    .limit(1);
  return row ? toRunDTO(row) : null;
}

/**
 * "I am done looking at this run" - the wizard stops opening on it.
 */
export async function dismissDokployReport(runId: string): Promise<void> {
  const { teamId } = await requireCapability("create_projects");
  await getDb()
    .update(runsTable)
    .set({ reportSeenAt: nowIso() })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
}

/**
 * The team's migration in flight, or null. There is at most one: opening a run
 * marks any older `running` row of the team Interrupted (see {@link
 * beginDokployImport}), so this is a fact, not a first-of-many.
 */
export async function activeDokployImportForTeam(
  teamId: string,
): Promise<ImportRunDTO | null> {
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.teamId, teamId), eq(runsTable.status, "running")));
  if (rows.length === 0) return null;
  // One row, by the same ordering the report reads in. Cheap enough to run on
  // every tick of the live feed: the index on (run_id, seq) makes it a lookup,
  // and the feed only re-reads when something actually changed.
  const [last] = await getDb()
    .select({ path: itemsTable.path })
    .from(itemsTable)
    .where(eq(itemsTable.runId, rows[0].id))
    .orderBy(desc(itemsTable.seq))
    .limit(1);
  return { ...toRunDTO(rows[0]), lastPath: last?.path ?? null };
}

export async function listDokployImports(): Promise<ImportRunDTO[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.teamId, teamId));
  return rows
    .sort((a, b) =>
      a.startedAt === b.startedAt
        ? b.seq - a.seq
        : a.startedAt < b.startedAt
          ? 1
          : -1,
    )
    .map(toRunDTO);
}

export async function getDokployImport(
  id: string,
): Promise<(ImportRunDTO & { items: ImportItemDTO[] }) | null> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, id), eq(runsTable.teamId, teamId)));
  if (rows.length === 0) return null;
  const items = await getDb()
    .select()
    .from(itemsTable)
    .where(eq(itemsTable.runId, id));
  return {
    ...toRunDTO(rows[0]),
    items: items
      .sort((a, b) => a.seq - b.seq)
      .map((i) => ({
        path: i.path,
        sourceKind: i.sourceKind,
        sourceName: i.sourceName,
        sourceId: i.sourceId,
        outcome: i.outcome,
        targetKind: i.targetKind,
        targetId: i.targetId,
        message: i.message,
        at: i.at,
      })),
  };
}

function toRunDTO(r: typeof runsTable.$inferSelect): ImportRunDTO {
  return {
    id: r.id,
    sourceUrl: r.sourceUrl,
    orgName: r.orgName,
    actor: r.actor,
    status: r.status,
    created: r.created,
    skipped: r.skipped,
    failed: r.failed,
    manual: r.manual,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    phase: r.phase,
    doneSteps: r.doneSteps,
    totalSteps: r.totalSteps,
    stepLabel: r.stepLabel,
    stopRequested: r.stopRequested,
    reportSeenAt: r.reportSeenAt,
    heartbeatAt: r.heartbeatAt,
    lastPath: null,
  };
}
