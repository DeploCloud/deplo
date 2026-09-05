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
  ne,
  or,
  sql,
} from "drizzle-orm";
import yaml from "../yaml";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  migrationRunItems as itemsTable,
  migrationRunDbHosts as dbHostsTable,
  migrationRunTargets as targetsTable,
  migrationRuns as runsTable,
  migrationSourceAddresses as sourceAddressesTable,
  domains as domainsTable,
  environments as environmentsTable,
  projects as projectsTable,
  serverTeams as serverTeamsTable,
  servers as serversTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { lookup } from "node:dns/promises";

import { mapLimit } from "../utils";
import { sourceAgentReachable } from "./agent-reach";
import { getCurrentUser } from "../auth";
import { avatarResolver, teamAvatarUrl as deploTeamAvatarUrl } from "../avatar";
import {
  canExposePorts,
  canMountHostVolumes,
  hasCapability,
  holdsTeamWideCapability,
  isInstanceAdmin,
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  requireTeamWide,
  teamsForUser,
} from "../membership";
import { assertSafeOutboundUrl } from "../outbound-url";
import {
  composeBuildReachesHost,
  composeClaimsReservedName,
  composeInterpolatedHostname,
  interpolatedHostnameMessage,
  composeHasHostBindMount,
  composeJoinsForeignNetwork,
  composeMountsForeignStorage,
  composeNeedsHostPrivileges,
  composeHostReach,
  composePublishesPorts,
  composeFileBindings,
  composeUsesExternalMerge,
  lintCompose,
  composeHostPorts,
} from "../deploy/compose-lint";
import { composeNamesOnNetwork } from "../deploy/compose-stack";
import { MIGRATION_HEARTBEAT_STALE_MS } from "../types";
import type { BuildConfig, PublishedPort, VolumeMount } from "../types";
import { reservedMountPath } from "../apps/volume-model";

import { listMembers, serviceDisplayName } from "../migration/dokploy/client";
import { normalizeSourceBaseUrl } from "../migration/transport";
import { detectMigrationSource } from "../migration/detect";
import {
  isMigrationPlatform,
  sourceClient,
  teamAvatarUrl,
} from "../migration/source";
import type { MigrationSourceClient } from "../migration/source";
import type { MigrationPlatform } from "../migration/source";
import type { SourceCredential } from "../migration/source";
import { SOURCE_DB_KINDS, type SourceDbKind } from "../migration/model";
import type {
  SourceApplication,
  SourceCompose,
  SourceDatabase,
  SourceEnvironment,
  SourceProject,
} from "../migration/model";
import {
  type MappedDomain,
  type SourcePlatformShape,
  adaptComposeForDeplo,
  composeRegistryNotes,
  cloneTarget,
  composeAsRepoApp,
  composeBuildServices,
  composeVolumeMounts,
  deploEngineFor,
  envNeedsInterpolation,
  mapBuildSettings,
  mapDatabase,
  mapDomains,
  mapLogo,
  mapMounts,
  mapResources,
  mapSource,
  renameClashingServices,
  renameHostTokens,
  parseEnvBlob,
  renameDatabaseHosts,
  resolveSharedRefs,
  mapPorts,
  retargetPlatformEnvFiles,
  swarmHealthCheck,
  unsupportedNotes,
  volumeLabel,
  withPanel,
} from "../migration/map";

import { addBasicAuthUser } from "./basic-auth";
import { addExistingMember, mintRegistrationLink } from "./members";
import {
  createApp,
  importedEnvType,
  setAppPorts,
  setAppVolumes,
  updateAppHealthCheck,
  updateAppResources,
} from "./apps";
import { writeAppFile } from "./app-files";
import { createCronJob } from "./crons";
import { createDatabase, setDatabaseMounts } from "./databases";
import { isValidExposePort } from "../databases/ports";
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
import { namesTakenOnNetwork } from "./name-clash";
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
import {
  saveSharedVar,
  setSharedVarAppLink,
  visibleSharedVarIdsByKey,
} from "./shared-vars";
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
  /**
   * Whether that server can actually be READ. A row a failed first attempt left
   * behind sits at the same address, and taking it for a connected machine is what
   * made the retry skip the install step and die in the data phase.
   */
  deploServerOnline: boolean;
}

export interface PlanMember {
  email: string;
  name: string;
  /** The role they held on Dokploy, for the admin to act on. Not imported. */
  sourceRole: string;
  /** Already has a Deplo account (matched on email). */
  hasAccount: boolean;
  /** Their picture and monogram colour, for the ones who do. Null for a stranger:
   *  an imported address is not sent to Gravatar. */
  avatarUrl: string | null;
  avatarColor: string | null;
  /** Already a member of this team. */
  inTeam: boolean;
}

export interface MigrationPlan {
  /** Which product answered. The wizard names it instead of asking. */
  platform: MigrationPlatform;
  sourceUrl: string;
  orgName: string | null;
  /** That team's picture over there, for the wizard to draw instead of a generic
   *  mark. Null when the panel keeps none, which on Coolify it never does. */
  orgAvatarUrl: string | null;
  /** The panel's OTHER teams, so the wizard can say which ones this token does
   *  not cover. Null when the panel cannot say - see {@link SourceIdentity}. */
  otherTeams: string[] | null;
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
  /** The team it landed in. Every call about the run names it, and the
   *  instance-wide history shows it. */
  teamId: string;
  teamName: string;
  teamSlug: string;
  teamAvatarUrl: string | null;
  /** Which product this run read. */
  platform: MigrationPlatform;
  sourceUrl: string;
  orgName: string | null;
  actor: string;
  /** The actor's picture and monogram colour, or nulls for a run whose starter
   *  has no account here any more. Never their email - see `avatarResolver`. */
  actorUsername: string | null;
  actorAvatarUrl: string | null;
  actorAvatarColor: string | null;
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

export interface MigrationInvite {
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
  /** Read the panel as this product. Absent means: work out which it is. */
  kind?: MigrationPlatform;
}

/* ------------------------------------------------------------------ */
/* Gates                                                              */
/* ------------------------------------------------------------------ */

/**
 * The entry gate.
 */
export async function assertImportGate(): Promise<{ teamId: string }> {
  await requireTeamWide("import from another platform");
  const { teamId } = await requireCapability("create_projects");
  return { teamId };
}

/**
 * The gate for what touches no team's data - reading the panel, taking the
 * wizard's agents back: the instance's page is an admin's, whatever their role
 * in the team it happens to be open in. Landing in a team keeps {@link
 * assertImportGate}.
 */
export async function assertPanelReadGate(): Promise<{ teamId: string }> {
  if (await isInstanceAdmin()) return { teamId: await requireActiveTeamId() };
  return assertImportGate();
}

/**
 * The teams a migration may land in: the viewer's own, minus the ones where they
 * do not hold `create_projects` across the WHOLE team - the same bar this page
 * itself is gated on, so switching into one never lands on "outside your access".
 */
export async function listMigrationTargetTeams(): Promise<
  { id: string; name: string; avatarUrl: string | null }[]
> {
  const user = await getCurrentUser();
  if (!user) return [];
  const teams = await teamsForUser(user.id);
  const allowed = await Promise.all(
    teams.map((t) => holdsTeamWideCapability(t.id, "create_projects")),
  );
  return teams
    .filter((_, i) => allowed[i])
    .map((t) => ({ id: t.id, name: t.name, avatarUrl: t.avatarUrl }));
}

/**
 * Hand the machines Deplo installed to READ the panel to the team the migration
 * now lands in. A source is granted to exactly one team at registration, and
 * every lookup that reads it - the plan's machines, the data copy, the uninstall -
 * is team-scoped, so a source left behind blocks the run and strands its agent.
 */
async function adoptMigrationSources(
  teamId: string,
  addresses: Set<string>,
): Promise<void> {
  if (addresses.size === 0) return;
  const rows = await getDb()
    .select({
      id: serversTable.id,
      ip: serversTable.ip,
      host: serversTable.host,
      teamId: serverTeamsTable.teamId,
    })
    .from(serversTable)
    .innerJoin(serverTeamsTable, eq(serverTeamsTable.serverId, serversTable.id))
    .where(
      and(
        eq(serversTable.importOnly, true),
        isNull(serversTable.uninstallNextAt),
        ne(serverTeamsTable.teamId, teamId),
      ),
    );
  const admin = await isInstanceAdmin();
  let moved = 0;
  for (const r of rows) {
    const at = [r.ip, r.host].map((a) => a?.trim().toLowerCase() ?? "");
    if (!at.some((a) => a && addresses.has(a))) continue;
    if (!admin && !(await holdsTeamWideCapability(r.teamId, "create_projects")))
      continue;
    if (await activeMigrationForTeam(r.teamId)) continue;
    await getDb()
      .update(serverTeamsTable)
      .set({ teamId })
      .where(
        and(
          eq(serverTeamsTable.serverId, r.id),
          eq(serverTeamsTable.teamId, r.teamId),
        ),
      );
    moved++;
  }
  if (moved > 0)
    await recordActivity(
      "server",
      `Moved ${moved} migration source ${moved === 1 ? "machine" : "machines"} to this team`,
      (await getCurrentUser())?.name ?? "a migration",
      null,
      teamId,
    );
}

export async function handOverMigrationSources(
  fromTeamId: string,
): Promise<number> {
  const { teamId } = await assertImportGate();
  if (fromTeamId === teamId) return 0;
  // Prove the mover could use those machines BEFORE, not only where they land -
  // or is the admin whose instance page registered them.
  if (
    !(await holdsTeamWideCapability(fromTeamId, "create_projects")) &&
    !(await isInstanceAdmin())
  )
    throw new Error("You cannot move a migration source out of that team.");
  // A run in flight is reading their disks right now; they are not yours to move.
  if (await activeMigrationForTeam(fromTeamId))
    throw new Error(
      "A migration is running in the team you are moving away from, so the machines it reads stay there.",
    );
  const rows = await getDb()
    .select({ id: serversTable.id })
    .from(serversTable)
    .innerJoin(serverTeamsTable, eq(serverTeamsTable.serverId, serversTable.id))
    .where(
      and(
        eq(serversTable.importOnly, true),
        eq(serverTeamsTable.teamId, fromTeamId),
        // One already on the way out belongs to the reaper, which reads the grant
        // it was queued with.
        isNull(serversTable.uninstallNextAt),
      ),
    );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  await getDb()
    .update(serverTeamsTable)
    .set({ teamId })
    .where(
      and(
        inArray(serverTeamsTable.serverId, ids),
        eq(serverTeamsTable.teamId, fromTeamId),
      ),
    );
  // Both trails: one team's machines left it, and they are another's now.
  const actor = (await getCurrentUser())?.name ?? "a migration";
  const what = ids.length === 1 ? "machine" : "machines";
  await recordActivity(
    "server",
    `Moved ${ids.length} migration source ${what} to another team`,
    actor,
    null,
    fromTeamId,
  );
  await recordActivity(
    "server",
    `Took over ${ids.length} migration source ${what} from another team`,
    actor,
    null,
    teamId,
  );
  return ids.length;
}

/**
 * Turn the typed address + key into a credential, refusing an address Deplo must
 * not dial. Same shape as `connectGitProvider`: the private-address escape hatch
 * asserts instance admin AT the decision, never inherits it from a caller.
 */
/** What the compose adapter needs to know about the platform this service is on:
 *  the name a note says, and the networks that are the platform's, not the stack's. */
function composePlatform(
  c: SourceCredential,
  svc: { kind: string; id: string },
): SourcePlatformShape {
  const src = sourceClient(c);
  return { name: src.displayName, networks: src.platformNetworks(svc) };
}

export async function credentialFor(
  input: ConnectInput,
): Promise<SourceCredential> {
  const baseUrl = normalizeSourceBaseUrl(input.url);
  // The address says whether this is the same-machine / LAN case, so nobody has to
  // declare it: private means instance admin, like a git connection's flag.
  try {
    await assertSafeOutboundUrl(baseUrl, "The panel address", {
      allowHttp: true,
    });
  } catch {
    await requireInstanceAdmin().catch(() => {
      throw new Error(
        "Only an instance admin can point Deplo at a private address",
      );
    });
  }
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("Paste the panel's API key");
  // The SSRF gate is above, so the detection's own request is behind it too.
  const kind = input.kind ?? (await detectMigrationSource(baseUrl, apiKey));
  return { kind, baseUrl, apiKey };
}

/* ------------------------------------------------------------------ */
/* Reading the source tree                                            */
/* ------------------------------------------------------------------ */

/**
 * One Dokploy service as `project.all` gives it: an id, a kind, and whatever else
 * happened to be projected.
 */
interface SourceService {
  kind: "application" | "compose" | SourceDbKind;
  id: string;
  /** From the tree when it was there; the authority is the detail row. */
  name: string;
  serverId: string;
}

function servicesOf(env: SourceEnvironment): SourceService[] {
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
  for (const kind of SOURCE_DB_KINDS)
    for (const row of (env[kind] ?? []) as SourceDatabase[]) {
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

/** The detail call for one service - the only shape difference between kinds. */
function loadService(
  c: SourceCredential,
  svc: SourceService,
): Promise<SourceApplication | SourceCompose | SourceDatabase> {
  return sourceClient(c).getService(svc.kind, svc.id);
}

/** What to call a service Deplo will NOT import: worth one detail call, since
 *  the tree carries no name for a database and an id names nothing to anybody. */
async function nameOfService(
  c: SourceCredential,
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

/** What one token turns out to read. See {@link identifyMigrationSource}. */
export interface SourceIdentity {
  platform: MigrationPlatform;
  /** The source team's own id, which is what tells two tokens of ONE team apart
   *  from two tokens of two teams. Null when the panel would not say. */
  teamId: string | null;
  teamName: string | null;
  /** That team's picture over there. Null when the panel keeps none. */
  teamAvatarUrl: string | null;
  /**
   * The panel's other teams, by name - never the ones already added here, which
   * only the caller knows. Null when the panel cannot say, which is always the
   * case on Coolify, and means the wizard has to ask instead of listing.
   */
  otherTeams: string[] | null;
}

/**
 * WHICH team a token reads, without reading it all. A token covers exactly one
 * team of the panel on both products, so bringing several over takes one token
 * each, and the wizard has to be able to collect them without paying for a full
 * scan per token (a fresh Dokploy key is rate-limited to ten requests a day).
 */
export async function identifyMigrationSource(
  input: ConnectInput,
): Promise<SourceIdentity> {
  await assertPanelReadGate();
  const c = await credentialFor(input);
  // The same refusal the scan opens with, one token earlier: a token that cannot
  // read values is worth catching while it is still one line in a list.
  await sourceClient(c).assertReadable();
  const [team, others] = await Promise.all([
    sourceClient(c).sourceTeam(),
    sourceClient(c).otherTeams(),
  ]);
  return {
    platform: c.kind,
    teamId: team.id,
    teamName: team.name,
    teamAvatarUrl: teamAvatarUrl(team.avatarUrl),
    otherTeams: others,
  };
}

/**
 * Read the source instance and describe what an import would do - without writing
 * anything.
 */
export async function scanMigrationSource(
  input: ConnectInput,
  /** `newTeam`: the plan for a team that does not exist yet. Nothing is there
   *  already, and every other team's hostname is somebody else's. */
  opts: { newTeam?: boolean } = {},
): Promise<MigrationPlan> {
  const { teamId } = opts.newTeam
    ? await assertPanelReadGate()
    : await assertImportGate();
  const c = await credentialFor(input);
  // Before anything is read in bulk: can this credential read at all? A panel that
  // hides values silently would produce a migration that looks like it worked.
  await sourceClient(c).assertReadable();

  const [sourceTeam, otherTeams, servers, projects] = await Promise.all([
    sourceClient(c).sourceTeam(),
    sourceClient(c).otherTeams(),
    sourceClient(c)
      .listServers()
      .catch(() => []),
    sourceClient(c).listProjects(),
  ]);

  // A source an earlier run registered belongs to THAT run's team, and a scan in
  // another team could not see it: the Install step then offered to register a
  // machine Deplo already stands on, and refused itself. A source is the
  // migration's, not a team's, so this scan claims the ones at this panel's
  // addresses - the same rule (and the same right) as handing them over.
  if (!opts.newTeam)
    await adoptMigrationSources(
      teamId,
      new Set(
        [new URL(c.baseUrl).hostname, ...servers.map((s) => s.ipAddress)]
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

  // Which source machines ARE Deplo servers, for the address note below. Read
  // once and lazily: the listing is a call to the panel.
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
      // `mapLimit` runs the callback for its side effects, so the slot is filled
      // by index, which is also what keeps the preview in Dokploy's own order.
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
            engine: deploEngineFor(svc.kind as SourceDbKind),
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

          // The detail row is the first place a name is guaranteed: `project.all`
          // gives a database nothing but its id, so until now this line may have had
          // no name at all. Same for the MACHINE: the tree carries no server, so
          // every service on the second host was read as the panel's own.
          line.name = nameOf(detail, svc);
          line.sourceServerId = detail.serverId?.trim() || line.sourceServerId;
          line.logo = mapLogo((detail as SourceApplication).icon);
          // What the ADAPTER saw and no shared mapper can: a field of its own
          // platform with no home here.
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
          // The scan has to say what the import would say. Two different facts:
          // a reference to a shared variable BECOMES one here, and everything else
          // the panel templates arrives as it is written.
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
          // Said BEFORE anyone presses import, because it is the one thing about a
          // migrated app that is not the same afterwards: the address. The route
          // survives; the name cannot (it carries the source server's IP) - unless
          // that machine is a Deplo server, where it still resolves.
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
            // The same call the notes come from: a git source is the only one Deplo
            // builds, so this costs nothing beyond keeping the result.
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

  // The mappers write `{panel}`; the preview is the first place a person reads
  // one, so it is resolved here rather than in every push above.
  const panel = sourceClient(c).displayName;
  for (const p of planned)
    for (const env of p.environments)
      for (const svc of env.services)
        svc.notes = svc.notes.map((n) => withPanel(n, panel));

  return {
    platform: c.kind,
    sourceUrl: c.baseUrl,
    orgName: sourceTeam.name,
    orgAvatarUrl: teamAvatarUrl(sourceTeam.avatarUrl),
    otherTeams,
    projects: planned,
    servers: await planMachines(c, teamId, servers, { probe: true }),
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
        // A service sharing another namespace (the host's, or a sidecar's) is not
        // reachable through Deplo's proxy, so its address - if it had one over
        // there - is now a host port and nothing else.
        d.rule === "network-mode-host" ||
        d.rule === "network-mode-conflict" ||
        // A network the stack pins by name still deploys, so it is never a
        // blocker - but the report is the only place it is ever mentioned to
        // someone who holds the grant.
        d.rule === "foreign-network",
    )
    .map((d) => d.message);
}

/**
 * Which of Deplo's compose gates this file would trip, as sentences. Deliberately
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
      `A service claims the name "${reserved}", which Deplo's own infrastructure answers to on the shared network - rename it (or its \`hostname:\`).`,
    );
  const filled = composeInterpolatedHostname(compose);
  if (filled) out.push(interpolatedHostnameMessage(filled));
  if (!grants.mayExposePorts && composePublishesPorts(compose))
    out.push("Publishes host ports, which needs the expose-ports grant.");
  const reach = grants.mayMountHost ? [] : composeHostReach(compose);
  if (reach.length > 0)
    out.push(
      `Uses ${reach.join(", ")}, which needs the host-volumes grant - without it this stack does not come across at all.`,
    );
  return out;
}

interface ExistingNames {
  projects: Map<string, string>;
  environments: Map<string, string>;
  apps: Map<string, string>;
  databases: Map<string, string>;
}

/** What a team that is not made yet already holds. */
function nothingHere(): ExistingNames {
  return {
    projects: new Map(),
    environments: new Map(),
    apps: new Map(),
    databases: new Map(),
  };
}

/** Everything already in this team, by lowercase name, for the skip decision. */
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

/**
 * Every hostname on this instance that belongs to a DIFFERENT team. Knowing the
 * set up front is what lets the preview say so before anything is written.
 * `null` is a team not made yet, to which every hostname is another team's.
 */
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

/**
 * Every machine behind that Dokploy, each paired with the Deplo server at the same
 * address - or nothing, when Deplo has no agent there.
 */
export async function migrationMachines(
  c: SourceCredential,
  teamId: string,
): Promise<PlanServer[]> {
  return planMachines(
    c,
    teamId,
    await sourceClient(c)
      .listServers()
      .catch(() => []),
  );
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
export async function rememberMigrationMachineAddress(
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
export async function setMigrationMachineAddress(input: {
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
  await rememberMigrationMachineAddress(
    input.sourceUrl,
    input.sourceId,
    input.address,
  );
  return { warning };
}

/**
 * Which of these addresses is THIS machine. A name is not enough: a panel on the
 * same box is typed as the name it is opened on, which matched nothing - so Deplo
 * registered the host a second time and asked for another agent on it.
 */
async function selfAddresses(
  candidates: (string | null | undefined)[],
  self: Set<string>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const wanted = [
    ...new Set(
      candidates
        .map((a) => a?.trim().toLowerCase())
        .filter((a): a is string => Boolean(a)),
    ),
  ];
  await mapLimit(wanted, 8, async (a) => {
    if (isDeploHostServer({ ip: a, host: a }, self)) {
      out.add(a);
      return;
    }
    try {
      const hits = await lookup(a, { all: true });
      if (hits.some((h) => self.has(h.address.toLowerCase()))) out.add(a);
    } catch {
      /* a name nothing resolves is simply not this machine */
    }
  });
  return out;
}

async function planMachines(
  c: SourceCredential,
  teamId: string,
  servers: { serverId: string; name: string; ipAddress?: string | null }[],
  /** Dial the agents whose reachability nothing has ever measured. The wizard's
   *  readiness needs it; a caller that only wants the id mapping does not. */
  opts: { probe?: boolean } = {},
): Promise<PlanServer[]> {
  // Migration sources stay in this list on purpose: matching a machine to the
  // agent that can read its disks is the ONE lookup they exist for, and a second
  // pass of the same import has to find the one the first pass registered.
  const mine = (await listServersForTeam(teamId)).filter((s) => !s.storageOnly);
  const byId = new Map(mine.map((s) => [s.id, s] as const));
  const self = deploHostSelfAddresses();
  const remembered = await rememberedAddresses(teamId, c.baseUrl);
  let ownAddress: string | null = null;
  try {
    ownAddress = new URL(c.baseUrl).hostname;
  } catch {
    /* the client already normalised this; a bad one just matches nothing */
  }
  const mineSelf = await selfAddresses(
    [
      ownAddress,
      ...servers.map((s) => s.ipAddress),
      ...remembered.values(),
      ...mine.flatMap((s) => [s.ip, s.host]),
    ],
    self,
  );
  const isSelf = (address: string | null | undefined) => {
    const a = address?.trim().toLowerCase();
    return Boolean(a && mineSelf.has(a));
  };
  const at = (address: string | null) => {
    const a = address?.trim().toLowerCase();
    if (!a) return null;
    const hit =
      mine.find(
        (s) =>
          s.ip?.trim().toLowerCase() === a ||
          s.host?.trim().toLowerCase() === a,
      ) ??
      // The same-machine case: the other platform runs on the box Deplo runs on.
      (isSelf(a)
        ? mine.find((s) => isDeploHostServer(s, self) || isSelf(s.ip ?? s.host))
        : undefined);
    return hit ? { deploServerId: hit.id, deploServerName: hit.name } : null;
  };

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

  const rows = [
    machine("", `The ${sourceClient(c).displayName} host`, ownAddress),
    ...servers.map((s) => machine(s.serverId, s.name, s.ipAddress ?? null)),
  ];

  // The row is MATCHED either way - that is what stops a second attempt
  // registering the same address twice - but only an agent that ANSWERS means the
  // machine is ready to be read.
  //
  // `status` alone is not that: it goes green on the agent's own CALL-HOME, which
  // is outbound and proves nothing about the direction a copy needs - behind a CDN
  // it read online while the port Deplo dials was never open. `statusCheckedAt` is
  // written only by a probe that DIALED the agent, so where there is one, it is the
  // answer. Where there is none - every freshly enrolled agent, which is every
  // machine this wizard just installed on - nothing had ever asked, and the step
  // sat on "not online" for a host that was answering fine. So ask, once.
  const unproven = opts.probe
    ? [
        ...new Set(
          rows
            .filter(
              (m) =>
                m.deploServerId && !byId.get(m.deploServerId)?.statusCheckedAt,
            )
            .map((m) => m.deploServerId!),
        ),
      ]
    : [];
  const answered = new Map<string, boolean>();
  await mapLimit(unproven, 4, async (id) => {
    answered.set(id, await sourceAgentReachable(id));
  });

  return rows.map((m) => {
    const hit = m.deploServerId ? byId.get(m.deploServerId) : null;
    return {
      ...m,
      deploServerOnline: hit
        ? hit.statusCheckedAt
          ? hit.status === "online"
          : (answered.get(hit.id) ?? false)
        : false,
    };
  });
}

/** What to call an imported person. Dokploy's `name` column is their ACCOUNT - the
 *  address - and their own name sits in `firstName`, so every imported member was
 *  listed by email. */
function personName(m: {
  user?: {
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  const first = (m.user?.firstName ?? m.firstName ?? "").trim();
  const last = (m.user?.lastName ?? m.lastName ?? "").trim();
  const full = [first, last].filter(Boolean).join(" ");
  if (full) return full;
  const named = (m.user?.name ?? m.name ?? "").trim();
  return named.includes("@") ? named.split("@")[0] : named;
}

/** Dokploy's members, told apart by whether they already exist here. */
async function planMembers(
  c: SourceCredential,
  teamId: string,
): Promise<PlanMember[]> {
  let rows: Awaited<ReturnType<typeof listMembers>>;
  try {
    rows = await sourceClient(c).listMembers();
  } catch {
    // A member-scoped key cannot list the organization. Not knowing who is on the
    // other side must not stop a project import.
    return [];
  }

  const people = rows
    .map((m) => ({
      email: (m.user?.email ?? m.email ?? "").trim().toLowerCase(),
      name: personName(m),
      // Empty only when the panel really does not say - both of them do.
      sourceRole: (m.role ?? "").trim(),
    }))
    .filter((p) => p.email.includes("@"));
  if (people.length === 0) return [];

  const accounts = await getDb()
    .select({
      id: usersTable.id,
      email: usersTable.email,
      image: usersTable.image,
      avatarColor: usersTable.avatarColor,
    })
    .from(usersTable)
    .where(
      inArray(
        sql`lower(${usersTable.email})`,
        people.map((p) => p.email),
      ),
    );
  const byEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a]));
  const memberIds = new Set(await teamMemberIds(teamId));
  const url = await avatarResolver();

  return people.map((p) => {
    const account = byEmail.get(p.email) ?? null;
    return {
      ...p,
      name: p.name || p.email,
      hasAccount: account != null,
      avatarUrl: account ? url(account) : null,
      avatarColor: account?.avatarColor ?? null,
      inTeam: account != null && memberIds.has(account.id),
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
export async function beginMigration(input: {
  url: string;
  orgName?: string | null;
  kind?: MigrationPlatform;
  /** More teams of this panel are still to come - see `migration_runs.keep_sources`. */
  keepSources?: boolean;
}): Promise<string> {
  const { teamId } = await assertImportGate();
  const user = await getCurrentUser();
  const db = getDb();
  const now = nowIso();

  // A run that is STILL BEING DRIVEN is not debris to clear: two of them creating
  // the same projects at once produced the same app twice and a pile of orphans,
  // because the second one's "is this already here?" read ran before the first
  // had written. A double click on Start is exactly that.
  const live = await db
    .select({
      id: runsTable.id,
      actor: runsTable.actor,
      startedAt: runsTable.startedAt,
      heartbeatAt: runsTable.heartbeatAt,
    })
    .from(runsTable)
    .where(
      and(
        eq(runsTable.teamId, teamId),
        eq(runsTable.status, "running"),
        // A stored key is what says the RUNNER owns this one. A run without it
        // is a tab that went away, and clearing it is the whole point below.
        isNotNull(runsTable.apiKeyEnc),
      ),
    );
  const alive = live.find(
    (r) =>
      Date.now() - Date.parse(r.heartbeatAt ?? r.startedAt) <
      MIGRATION_HEARTBEAT_STALE_MS,
  );
  if (alive)
    throw new Error(
      `${alive.actor} already has a migration running in this team. Wait for it to finish, or stop it from Settings → System → Migrations.`,
    );

  const interrupted = await db
    .update(runsTable)
    .set({
      status: "failed",
      error:
        "Stopped answering, so it was marked failed when the next migration started. Whatever it created is still here - the log says what.",
      finishedAt: now,
    })
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
    sourceUrl: normalizeSourceBaseUrl(input.url),
    platform: input.kind ?? "dokploy",
    orgName: input.orgName?.trim() || null,
    keepSources: input.keepSources ?? false,
    actor: user?.name ?? "someone",
    // The id as well as the display name: it is what says whose wizard opens on
    // this run again (`resumableMigration`), and the runner overwrites it
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
      await appendRunItem(runId, "the panel", {
        path: s.name,
        sourceKind: "server",
        sourceName: s.name,
        outcome: "manual",
        // Never "the data is on THIS machine": the commonest reason a copy left
        // data behind is that Deplo asked the wrong machine, and this is exactly
        // the one that did not have it.
        message:
          `Deplo's agent is still on ${s.name}: this migration left data that ` +
          `has not been copied yet, and its agents are how Deplo reaches it. ` +
          `Remove it once the copy is done.`,
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
 * Data this run could not bring across. Its bytes are still on the source host and
 * the agent is the only way to fetch them, so nothing may take that agent off
 * until a person says so.
 *
 * A failed VOLUME line is one signal; `data_copy_error` on what the run created is
 * the other, and the only one a service the data phase never reached has - one
 * machine of several would not answer, so it has no volume line at all.
 */
async function hasStrandedVolume(runId: string): Promise<boolean> {
  const failedVolume = await getDb()
    .select({
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.runId, runId),
        eq(itemsTable.sourceKind, "volume"),
        eq(itemsTable.outcome, "failed"),
      ),
    );

  const rows = await getDb()
    .select({
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
  // A report line is HISTORY. The marker on the resource is the current state, and
  // a recopy clears it - read the line alone and one failure held the agent on the
  // source machine for good, with no way in the UI to say the data had arrived.
  const stillMarked = async (kind: string, ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return false;
    const table = kind === "app" ? appsTable : databasesTable;
    const hit = await getDb()
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, ids), ne(table.dataCopyError, "")))
      .limit(1);
    return hit.length > 0;
  };
  for (const kind of ["app", "database"]) {
    const ids = [
      ...new Set(
        failedVolume
          .filter((r) => r.targetKind === kind && r.targetId)
          .map((r) => r.targetId!),
      ),
    ];
    if (await stillMarked(kind, ids)) return true;
  }
  // A failed line that names no target at all: nothing can clear it, so it stands.
  if (failedVolume.some((r) => !r.targetId)) return true;

  const appIds = idsOf("app");
  if (appIds.length > 0) {
    const hit = await getDb()
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(
        and(inArray(appsTable.id, appIds), ne(appsTable.dataCopyError, "")),
      )
      .limit(1);
    if (hit.length > 0) return true;
  }
  const dbIds = idsOf("database");
  if (dbIds.length > 0) {
    const hit = await getDb()
      .select({ id: databasesTable.id })
      .from(databasesTable)
      .where(
        and(
          inArray(databasesTable.id, dbIds),
          ne(databasesTable.dataCopyError, ""),
        ),
      )
      .limit(1);
    if (hit.length > 0) return true;
  }
  return false;
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
export async function abandonMigration(): Promise<number> {
  const { teamId } = await assertPanelReadGate();
  const actor = (await getCurrentUser())?.name ?? "the migration";

  const [latest] = await getDb()
    .select({ id: runsTable.id, status: runsTable.status })
    .from(runsTable)
    .where(eq(runsTable.teamId, teamId))
    .orderBy(desc(runsTable.seq))
    .limit(1);
  // `stopped` is a pause, not an ending: re-running is how a stopped migration is
  // resumed (see `stopMigration`), and it can only be resumed through the
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
    await appendRunItem(source.runId, "the panel", {
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
    "server",
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
export async function finishMigration(runId: string): Promise<void> {
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
  // The services are the team's again before anything else happens: the sweep
  // below dials hosts and can take a minute, and none of that is a reason to
  // keep a finished migration's apps frozen.
  if (closed.length > 0) await releaseMigrating(runId);
  const [row] = await getDb()
    .select({ keepSources: runsTable.keepSources })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)))
    .limit(1);
  // Swept whether or not THIS call is what ended the run. A run that already
  // failed still owns the agents it put on those machines, and leaving them there
  // is what made the next attempt find a machine that was "already connected".
  // Unless another team of the same panel is next: it reads the same disks, and a
  // scheduled uninstall would race the install that follows it.
  if (!row?.keepSources) await removeMigrationSources(runId, teamId);
  await refreshCounts(runId, teamId);
}

/** The open run of this team, as ids only - the writer's cheap ownership check.
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
 * deepens the breadcrumb but SHARES the items array - the caller gets one flat
 * report for the whole project, in the order things happened.
 */
class Report {
  /** The run these lines belong to, for the tables that hang off it. */
  get id(): string | null {
    return this.runId;
  }
  constructor(
    private readonly runId: string | null,
    /** The source product's name. A mapper writes `{panel}`; this is what it
     *  becomes, so a Coolify run never says what happened "on Dokploy". */
    private readonly panel: string,
    private readonly path: string[] = [],
    readonly items: ImportItemDTO[] = [],
  ) {}

  /** A child collector one level deeper in the breadcrumb, same run, same list. */
  at(segment: string): Report {
    return new Report(
      this.runId,
      this.panel,
      [...this.path, segment],
      this.items,
    );
  }

  async add(entry: {
    path?: string;
    sourceKind: string;
    sourceName: string;
    /** The Dokploy service id, when this row IS a service. What the data cutover
     *  pairs on - see `migration_run_items.source_id`. */
    sourceId?: string | null;
    outcome: "created" | "skipped" | "failed" | "manual" | "unsupported";
    targetKind?: string | null;
    targetId?: string | null;
    message?: string | null;
  }): Promise<void> {
    const row: ImportItemDTO = {
      path: withPanel(entry.path ?? this.path.join(" / "), this.panel),
      sourceKind: entry.sourceKind,
      // Every COLUMN a person reads, not only the message: a row whose subject is
      // the panel itself has the placeholder in its name.
      sourceName: withPanel(entry.sourceName, this.panel),
      sourceId: entry.sourceId ?? null,
      outcome: entry.outcome,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      message: entry.message ? withPanel(entry.message, this.panel) : null,
      // Stamped here, once, so the in-memory copy the caller reads and the row
      // the log reads agree on when it happened.
      at: nowIso(),
    };
    this.items.push(row);
    if (!this.runId) return;
    // The data phase writes every plan note, then the copy writes the same notes
    // again from its own read of the panel - so one advisory reached the report
    // twice, word for word. An outcome line is never dropped; advice is.
    if (row.outcome === "manual" && (await this.alreadySaid(row))) return;
    await getDb()
      .insert(itemsTable)
      .values({ id: newId("dimi"), runId: this.runId, ...row });
    // Everything this run CREATES is the run's to write until it ends.
    if (row.outcome === "created") await markMigrating(this.runId, row);
  }

  /** Has this run already recorded this exact advisory, on this exact subject? */
  private async alreadySaid(row: ImportItemDTO): Promise<boolean> {
    if (!row.message) return false;
    const hit = await getDb()
      .select({ id: itemsTable.id })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.runId, this.runId!),
          eq(itemsTable.outcome, "manual"),
          eq(itemsTable.path, row.path),
          eq(itemsTable.message, row.message),
        ),
      )
      .limit(1);
    return hit.length > 0;
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
  panel: string,
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
  await new Report(runId, panel).add(entry);
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
    .where(
      and(
        eq(table.id, row.targetId),
        // Only while the run is OPEN. A re-copy appends its `created` lines to a
        // run that finished long ago, and marking there froze the app for good.
        sql`exists (select 1 from ${runsTable} where ${runsTable.id} = ${runId} and ${runsTable.status} = 'running')`,
      ),
    );
}

/**
 * Marks whose run is over. The marker outlives its run, and a row still carrying
 * one refuses every deploy behind a migration there is nothing left to finish.
 */
export async function sweepFinishedMigrationMarks(): Promise<void> {
  for (const table of Object.values(MIGRATING_TABLES))
    await getDb()
      .update(table)
      .set({ migrationRunId: null })
      .where(
        sql`${table.migrationRunId} is not null and not exists (
          select 1 from ${runsTable}
          where ${runsTable.id} = ${table.migrationRunId}
            and ${runsTable.status} = 'running'
        )`,
      );
}

/**
 * Hand everything this run created back to the people who own it. Exported for
 * the runner: a run that FAILS has to let go too, or its apps are frozen for
 * good - the marker outlives the run that set it.
 */
export async function releaseMigrating(runId: string): Promise<void> {
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
  /** Dokploy server id (or "") → Deplo server id. Unmapped falls back to default. */
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

  // What a database was called on the other side, and what it answers to here.
  // Filled in as the databases land and read by every app imported after them,
  // which is why the databases of an environment are imported first - and kept
  // with the RUN, so an app in a later project sees the databases of an earlier one.
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

  // What the caller picked, or everything. A service left out is left out
  // SILENTLY: it is a choice made on the review screen, not an event, and a
  // report line per unticked box would bury the ones that need reading.
  const wanted = input.serviceIds ? new Set(input.serviceIds) : null;
  const picked = (env: SourceEnvironment) =>
    servicesOf(env).filter((s) => !wanted || wanted.has(s.id));

  // The shared variables come FIRST, because a link needs the row it points at.
  // Levels in reach order: team, project, then each machine that hosts something
  // we are importing.
  const shared: SharedIndex = new Map();
  await noteLevel(report, source.platformNotes);
  try {
    await importSharedVars(
      await sourceClient(c).teamSharedEnv(),
      {
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
      await importSharedVars(
        await sourceClient(c).serverSharedEnv(sourceServerId),
        {
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
    const envBlob =
      env.env ??
      (await sourceClient(c).getEnvironment(env.environmentId))?.env ??
      null;
    await importSharedVars(
      envBlob,
      {
        teamId,
        label: `${source.name} / ${env.name}`,
        environmentIds: [environmentId],
        projectIds: [],
        scopeNote: `Offered to ${env.name}.`,
        report: envReport,
      },
      shared,
    );

    /** Apps landed in this environment. */
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
      // The DETAIL is loaded here rather than inside each importer, because it is also
      // where the service's real name lives: `project.all` gives a database nothing but
      // its id, so a report scoped before this call would have an empty breadcrumb for
      // exactly the objects hardest to identify.
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
              // Whether the machine this database runs on over there IS the machine it is about
              // to run on here - the one case where the port it wants is held by the very
              // container we are importing, and stopping that frees it.
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

/** Dokploy server id (or "") → a Deplo server this team can actually deploy to. */
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
        sourceName: from || "the {panel} host",
        outcome: "manual",
        message:
          "The server picked for this {panel} host is not one this team can deploy to - Deplo's default server was used instead.",
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
        message: `Port ${exposedPort} is not a port a database can publish (1024-65535) - the one it had on {panel} was used instead.`,
      });
      exposedPort = undefined;
    }
    out.set(p.serviceId, { serverId: p.serverId, buildServerId, exposedPort });
  }
  return out;
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

/**
 * The Deplo Environment for a Dokploy one.
 */
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

/** The adapter's own notes for one level of the tree, straight onto the report. */
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

/**
 * A shared-variable level the panel would not answer for. `manual`, not `failed`:
 * an older build simply has no such endpoint, `failed` is for a write that failed,
 * and `manual` already means "a person has to look at this".
 */
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

/* ---- applications and compose stacks -------------------------------- */

/**
 * One Dokploy application or compose stack → one Deplo App, with its env vars,
 * config files, primary domain, extra domains, volumes, resource limits,
 * basic-auth users and crons.
 */
/**
 * Why this compose cannot be created by the person running the import, or null.
 * The remedy is the SAME sentence a single-image app's dropped bind mount gets:
 * a report that names a permission has to say who turns it on.
 */
async function composeGrantRefusal(
  compose: string,
  name: string,
): Promise<string | null> {
  const reach = composeHostReach(compose);
  if (reach.length > 0 && !(await canMountHostVolumes()))
    return `${name} uses ${reach.join(", ")}, which needs the host-volumes permission, so its stack did not come across. An admin turns it on with "Bind server folders" in Settings -> Users, then import this app again.`;
  if (composePublishesPorts(compose) && !(await canExposePorts()))
    return `${name} publishes ports on the server, which needs the expose-ports permission, so its stack did not come across. An admin turns it on with "Publish ports" in Settings -> Users, then import this app again.`;
  return null;
}

/** The host an app lands on when nobody named one - the same pick `createApp`
 *  makes, needed here because the network a name is checked against is per host. */
async function landingServerId(given: string | undefined): Promise<string> {
  if (given) return given;
  const teamId = await requireActiveTeamId();
  const usable = (await listServersForTeam(teamId)).filter(canHostWorkloads);
  return usable[0]?.id ?? "";
}

async function importAppService(
  c: SourceCredential,
  svc: SourceService,
  detail: SourceApplication & SourceCompose,
  name: string,
  home: {
    projectId: string;
    environmentId: string;
    serverId: string | undefined;
    buildServerId: string | null;
    /** The Deplo server that IS the machine it ran on, when there is one. */
    sourceHost: string | null;
    /** Old database hostname -> the one Deplo gave it, for the connection strings
     *  this app's variables still spell out. */
    dbHosts: Map<string, string>;
    /** The shared variables this import has already written, by key. */
    shared: SharedIndex;
    /** Backup destination name (lower-case) -> Deplo destination id. */
    destinations?: Map<string, string>;
  },
  report: Report,
): Promise<string | null> {
  // Which Dokploy table it sat in. Whether it is a STACK here is decided below:
  // a compose service can turn out to be one app built from its own repository,
  // and importing that as a stack produces something that cannot deploy.
  let isCompose = svc.kind === "compose";

  // Already here? Leave it completely alone - a second pass must not re-write
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

  const notes: string[] = [
    ...((detail as SourceApplication).platformNotes ?? []),
  ];

  // The same name somewhere ELSE in this team is allowed - an app lives in one
  // environment and staging may share a name with production - but never silent:
  // two apps called the same thing is a thing to walk into knowingly.
  const namesake = (
    await getDb()
      .select({
        slug: appsTable.slug,
        environmentName: environmentsTable.name,
      })
      .from(appsTable)
      .leftJoin(
        environmentsTable,
        eq(environmentsTable.id, appsTable.environmentId),
      )
      .where(
        and(
          eq(appsTable.teamId, await requireActiveTeamId()),
          sql`lower(${appsTable.name}) = ${name.trim().toLowerCase()}`,
          // `NULL <> id` is NULL, not true: an app sitting outside every
          // environment is exactly the one this has to see.
          or(
            isNull(appsTable.environmentId),
            ne(appsTable.environmentId, home.environmentId),
          ),
        ),
      )
      .limit(1)
  )[0];

  // Env: the service's own blob, plus its build args, which Deplo passes to the
  // build as ordinary variables (agent >= 1.9.0) rather than as a second channel.
  const envEntries = parseEnvBlob(detail.env);
  const argEntries = parseEnvBlob(
    (detail as SourceApplication).buildArgs,
  ).filter((a) => !envEntries.some((e) => e.key === a.key));
  const rows = [...envEntries, ...argEntries];

  // A value that is EXACTLY one reference to a shared variable of the SAME name is
  // a link here, not a copy: a link injects (ADR-0012), and it injects under the
  // shared variable's own key, so that is the only reference shape it can express.
  const refs = (detail.sharedRefs ?? []).filter(
    (r) => !argEntries.some((a) => a.key === r.key),
  );
  const linkable = refs.filter(
    (r) => r.whole && r.key === r.sharedKey && home.shared.has(r.sharedKey),
  );
  const dropped = new Map<string, { key: string; value: string }>();
  for (const r of linkable) {
    const i = rows.findIndex((e) => e.key === r.key);
    if (i !== -1) dropped.set(r.key, rows.splice(i, 1)[0]);
  }
  // Whatever is still a reference becomes a VALUE. A no-op on a panel that already
  // answered resolved; the real work on one that resolves at deploy time.
  const refResolved = resolveSharedRefs(
    rows,
    new Map([...home.shared].map(([k, v]) => [k, v.value] as const)),
  );
  // A credential the panel held encrypted must not land readable at the `view`
  // floor. Narrow on purpose (`importedEnvType`): a secret cannot be edited and a
  // fork's preview drops it, so a wrong guess breaks a working app.
  const env = rows.map((e) => ({ ...e, type: importedEnvType(e.key) }));
  const masked = env.filter((e) => e.type === "secret").map((e) => e.key);
  if (masked.length > 0)
    notes.push(
      `${masked.join(", ")} came across masked, because the name says it holds a credential. Open one and press Make it plain if it does not.`,
    );
  const aliased = refs.filter(
    (r) => r.whole && r.key !== r.sharedKey && home.shared.has(r.sharedKey),
  );
  if (linkable.length > 0)
    notes.push(
      `${linkable.map((r) => r.key).join(", ")} read a shared variable on {panel}, so ${
        linkable.length === 1 ? "it is" : "they are"
      } linked to the shared variable of the same name here instead of carrying a copy. Unlink under Variables to give this app its own value.`,
    );
  if (aliased.length > 0)
    notes.push(
      `${aliased
        .map((r) => `${r.key} read {{${r.level}.${r.sharedKey}}}`)
        .join(
          ", ",
        )}. A link here injects under the shared variable's own name, so it cannot be called something else - the value {panel} resolved came across instead.`,
    );
  if (refResolved.unresolved.length > 0)
    notes.push(
      `${refResolved.unresolved.join(
        ", ",
      )} still read a shared variable {panel} did not answer with the value behind. Put the real values in under Variables.`,
    );
  // The databases this same import renamed, before the app is created.
  const renamed = renameDatabaseHosts(env, home.dbHosts);
  if (renamed.length > 0)
    notes.push(
      `${renamed.join(", ")} named the database by its {panel} hostname, which does not exist here, so ${
        renamed.length === 1 ? "it now names" : "they now name"
      } the one Deplo gave it.`,
    );

  if (argEntries.length > 0)
    notes.push(
      `${argEntries.length} build argument(s) became environment variables - that is how Deplo passes values to a build.`,
    );
  const interpolated = envNeedsInterpolation(env);
  if (interpolated.length > 0)
    notes.push(
      `Deplo does not resolve {panel}'s \`\${{...}}\` templating - put the real values in: ${interpolated.join(", ")}.`,
    );

  // The compose text, read before anything that depends on the app's SHAPE: it
  // is what says whether this is a stack at all.
  let yamlText = "";
  if (isCompose) {
    const inline = (detail.composeFile ?? "").trim();
    yamlText =
      inline || (await sourceClient(c).getResolvedCompose(svc.id)) || "";
    if (!yamlText.trim()) {
      await report.add({
        sourceKind: svc.kind,
        sourceId: svc.id,
        sourceName: name,
        outcome: "failed",
        targetKind: "app",
        // Coolify keeps every stack's compose on the resource itself and has no
        // "resolved file" endpoint at all, so blaming a git repository sent people
        // to check their Source settings over a token scope.
        message:
          sourceClient(c).platform === "coolify"
            ? "{panel} handed over no compose file for this stack. A token without the read:sensitive scope is what usually does that - mint one with it and import again. Otherwise create the app and paste the compose in."
            : "The compose file is in a git repository and {panel} would not hand over the resolved file. Create the app and paste the compose in.",
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

  const domains = mapDomains(detail.domains, {
    isCompose,
    fallbackPort: (detail as SourceApplication).routingPort,
    compose: isCompose ? yamlText : null,
  });
  notes.push(...domains.notes);
  // Landing on the machine it ran on (a takeover): the generated name still
  // points here, so the address people already have keeps working.
  if (
    home.sourceHost != null &&
    home.sourceHost === (await landingServerId(home.serverId))
  )
    for (const d of domains.value)
      if (d.generated && !/(^|\.)localhost$/i.test(d.host)) d.generated = false;
  // The app's own address wins the primary slot over a temporary one, whatever order
  // the source kept them in: a throwaway host is first over there simply because
  // Dokploy minted it first, and promoting it here would demote the name people
  // actually type to a secondary row.
  const primary =
    domains.value.find((d) => !d.generated) ?? domains.value[0] ?? null;
  const mounts = mapMounts(detail.mounts, { isCompose, compose: yamlText });
  notes.push(...mounts.notes);

  // What createApp needs to know about the source.
  /** Services this import renamed to keep them off a name the network answers to. */
  let serviceRenames = new Map<string, string>();
  let source: Parameters<typeof createApp>[0]["source"] = "upload";
  let repo: Parameters<typeof createApp>[0]["repo"] = null;
  let dockerImage: string | null = null;
  let compose: string | null = null;
  /** Host ports the source published, carried over after the app exists. */
  let ports: PublishedPort[] = [];
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
      `On {panel} this was a compose file in ${repoTarget.repo}, and all it did was build that repository and run it - so it came across as an app built from ${repoTarget.repo}, not as a stack. Pushing to ${repoTarget.branch} deploys it.`,
    );
  } else if (isCompose) {
    source = "compose";
    const inline = (detail.composeFile ?? "").trim();
    if (!inline)
      notes.push(
        "The compose file is kept inline from now on, so changes in the repository will not follow.",
      );
    const adapted = adaptComposeForDeplo(yamlText, composePlatform(c, svc));
    // An `env_file` naming a file this stack does not carry is the other platform's own
    // env file under its own name (`stack.env` and friends).
    const retargeted = retargetPlatformEnvFiles(
      adapted.compose,
      mounts.value.files.map((f) => f.filePath),
    );
    compose = retargeted.compose;
    notes.push(
      ...adapted.changes,
      ...retargeted.changes,
      ...composeRegistryNotes(compose),
    );
    // Every stack in an Environment shares ONE network (ADR-0028), so two one-click
    // apps that both call their database `db` collide - and `createApp` refuses the
    // second one, which lost the whole app. The names are rewritten instead, here,
    // because only the import knows what is already answering on that network.
    const takenNames = await namesTakenOnNetwork({
      teamId: await requireActiveTeamId(),
      environmentId: home.environmentId,
      serverId: await landingServerId(home.serverId),
    });
    // Only the names this stack actually PUTS on that network: one it keeps to
    // itself (sealed `internal:`, `network_mode:`, a reserved name) contests
    // nothing, and renaming it would be an edit to the author's file for nothing.
    const mine = new Set(composeNamesOnNetwork(compose));
    const renamed = renameClashingServices(
      compose,
      new Set([...takenNames].filter((n) => mine.has(n))),
      name,
    );
    if (renamed.renames.size > 0) {
      compose = renamed.compose;
      notes.push(...renamed.changes);
      // A domain routes to a service BY NAME, and the panel answered with the old
      // one: left alone, every renamed stack's address answered nothing.
      for (const d of domains.value) {
        const to = d.service && renamed.renames.get(d.service.toLowerCase());
        if (to) d.service = to;
      }
      serviceRenames = renamed.renames;
      // The stack reads its own hostnames out of the env file too, not only out of
      // the YAML - a compose one-click puts `DATABASE_URL` there and nowhere else.
      renameHostTokens(env, renamed.renames);
    }
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
        "{panel} isolates this stack's network and volume names. Deplo does that for every stack - check the service names it talks to.",
      );
  } else {
    const app = detail as SourceApplication;
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
      // Deplo will not take). The app is still worth creating: its variables,
      // domains, mounts and limits are the part that takes an afternoon to retype.
      source = "upload";
      const watched = (app.watchPaths ?? []).filter((p) => p.trim());
      notes.push(
        "Set the source under the app's Source settings before deploying." +
          (watched.length > 0
            ? ` It only deployed on changes under ${watched.join(", ")} - set those again once the repository is there.`
            : ""),
      );
    }
    const mappedBuild = mapBuildSettings(app);
    notes.push(...mappedBuild.notes);
    Object.assign(build, mappedBuild.value);
    const mappedPorts = mapPorts(app);
    ports = mappedPorts.value;
    notes.push(...mappedPorts.notes);
    notes.push(...unsupportedNotes(app));
  }

  // Routing port: Dokploy keeps it on the domain, Deplo on the build config (a
  // domain may still override it). Taking the primary domain's port keeps the two
  // consistent from the start; a platform that records the port on the app itself
  // answers when there is no domain to read it off.
  const routingPort =
    primary?.port ?? (detail as SourceApplication).routingPort ?? null;
  if (routingPort) build.port = routingPort;

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

  // A stack that reaches the host cannot be written by somebody without the grant,
  // and `createApp` is right to refuse it. Said HERE it reads like the answer a
  // single-image app already gets for its bind mount - a line with the remedy -
  // rather than a failure that looks like a crash and names the wrong thing.
  const grantRefusal = compose
    ? await composeGrantRefusal(compose, name)
    : null;
  if (grantRefusal) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "manual",
      targetKind: "app",
      message: grantRefusal,
    });
    return null;
  }

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

  // What does not speak HTTP: the ports the source published, on the app itself
  // rather than as a line telling somebody to rewrite it as a compose stack.
  if (ports.length > 0) {
    if (!(await canExposePorts()))
      notes.push(
        `It published ${ports
          .map((p) => p.published)
          .join(
            ", ",
          )} on its host. You don't have permission to publish ports, so it came across without them - ask an instance admin, then add them under Settings -> Advanced.`,
      );
    else
      try {
        await setAppPorts(created.id, ports);
      } catch (e) {
        notes.push(
          `${ports.map((p) => `${p.published}:${p.target}`).join(", ")} could not be published here (${
            e instanceof Error ? e.message : "the port was refused"
          }). Set them under Settings -> Advanced.`,
        );
      }
  }

  // One name in two environments is the commonest shape there is, and it is not an
  // accident to be corrected - only the internal name, which is one per team, has
  // to give way.
  // The panel's volume backups and in-stack dumps, as app backups here: one per
  // schedule and destination, and an app backup covers EVERY volume of the app,
  // so two schedules on two volumes fold into one and the note says so.
  const schedules = (detail.backups ?? []).filter(
    (b) => b?.enabled !== false && b.schedule?.trim(),
  );
  if (schedules.length > 0) {
    const { createBackup } = await import("./backups");
    const seen = new Map<string, string[]>();
    for (const b of schedules) {
      const destName = b.destination?.name?.trim() ?? "";
      const what = b.volumeName?.trim()
        ? `volume ${b.volumeName.trim()}`
        : b.serviceName?.trim()
          ? `a dump of ${b.serviceName.trim()}`
          : "a dump";
      const key = `${b.schedule!.trim()}|${destName.toLowerCase()}`;
      const folded = seen.get(key);
      if (folded) {
        folded.push(what);
        continue;
      }
      seen.set(key, [what]);
      const destinationId = destName
        ? home.destinations?.get(destName.toLowerCase())
        : undefined;
      const where = `${b.schedule!.trim()}${destName ? ` to ${destName}` : ""}`;
      if (!destinationId) {
        notes.push(
          `${what} was backed up on {panel} (${where}), but that destination is not here, so no schedule was set - set one under Backups.`,
        );
        continue;
      }
      try {
        await createBackup({
          name: `${name} to ${destName}`,
          targetKind: "app",
          appId: created.id,
          databaseId: null,
          destinationId,
          schedule: b.schedule!.trim(),
          retentionCount:
            typeof b.keepLatestCount === "number" && b.keepLatestCount > 0
              ? b.keepLatestCount
              : 7,
        });
        notes.push(
          `Its backup schedule came across: ${where}. Here it backs up every volume of the app, not only ${what}.`,
        );
      } catch (e) {
        notes.push(
          `${what} was backed up on {panel} (${where}); the schedule was not set here: ${
            e instanceof Error ? e.message : "refused"
          }. Set one under Backups.`,
        );
      }
    }
    for (const [key, whats] of seen)
      if (whats.length > 1)
        notes.push(
          `${whats.join(", ")} shared the schedule ${key.split("|")[0]} on {panel}; one app backup here covers them all.`,
        );
  }

  if (namesake)
    notes.push(
      `This team already has an app called ${name}${
        namesake.environmentName
          ? ` in the ${namesake.environmentName} environment`
          : ""
      }. Both are kept; this one is /apps/${created.slug}.`,
    );

  // The links the references asked for. A value must never vanish because a link
  // could not be made, so a refusal writes the entry back instead.
  const linkRefused: { key: string; value: string }[] = [];
  for (const r of linkable) {
    try {
      await setSharedVarAppLink(
        home.shared.get(r.sharedKey)!.varId,
        created.id,
        true,
      );
    } catch {
      const back = dropped.get(r.key);
      if (back) linkRefused.push(back);
    }
  }
  if (linkRefused.length > 0) {
    // `setAppEnv` is a whole-set replace, so it takes the FULL set back.
    await setAppEnv(created.id, [...env, ...linkRefused], undefined, {
      overwriteSecrets: true,
    });
    notes.push(
      `${linkRefused
        .map((e) => e.key)
        .join(
          ", ",
        )} could not be linked to the shared variable, so ${linkRefused.length === 1 ? "it kept its" : "they kept their"} own copy of the value.`,
    );
  }

  await report.add({
    sourceKind: svc.kind,
    sourceId: svc.id,
    sourceName: name,
    outcome: "created",
    targetKind: "app",
    targetId: created.id,
    message: `${env.length} variable(s), ${
      linkable.length - linkRefused.length
    } shared variable(s), ${mounts.value.files.length} config file(s).`,
  });
  const target = { kind: "app", id: created.id };

  // EVERY address the app answered on over there has to be an address it answers on
  // here.
  const rehosted = new Map<string, string>();
  // Kept apart from `notes` so the warning about what the app stores about itself
  // can ride the last of them. As its own note it repeated, once per app, what the
  // line above had just said - half a clean run's report was these two sentences.
  const rehostNotes: string[] = [];
  if (domains.value.length === 0)
    notes.push(
      "It answered on no address on {panel}, so it arrives with none here either. Add one under Domains if it should be reachable from outside.",
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
      rehostNotes.push(
        primary.generated
          ? `${primary.host} was {panel}'s own temporary address, so this app answers on ${row.name} here - same port, same route.`
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
          rehostNotes.push(
            wasThrowaway.has(source)
              ? `${source} was {panel}'s own temporary address, so it comes across as ${host} here - same port, same route.`
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

  // The one place a re-hosted address cannot be fixed from out here: INSIDE the
  // app's own data. Said on the same line that names the new address.
  if (rehostNotes.length > 0) {
    const landedOn = [...new Set(rehosted.values())].join(", ");
    rehostNotes[rehostNotes.length - 1] +=
      ` If it stores its own address (a trusted_domains, a saved site URL), the copied data still holds the old one - open its Console and set it to ${landedOn}.`;
    notes.push(...rehostNotes);
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
        // Secrets included: an address arrives write-only as often as not, and this
        // is the import correcting a value it wrote itself a moment ago.
        await setAppEnv(created.id, rewritten, undefined, {
          overwriteSecrets: true,
        });
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
      // Retried once on purpose: it is a single call to a host that answered a
      // moment ago, and this content lives nowhere else on this side.
      try {
        await writeAppFile(created.id, f.filePath, f.content);
      } catch {
        await writeAppFile(created.id, f.filePath, f.content);
      }
    } catch (e) {
      unwritten.add(f.filePath);
      // Only worth saying for a single-image app: there, a file that was not
      // written is a file that is GONE, and its mount is dropped below with it.
      // The stack's own deploy will write the compose one on its own.
      if (!isCompose)
        notes.push(
          `${f.filePath} could not be written into this app's Files: ${
            e instanceof Error ? e.message : "refused"
          }. {panel} still has it - copy it from there into Files, and mount it under Storage.`,
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

  // The other panel fills `healthCheck`; Dokploy keeps the same thing in Swarm's
  // own shape, and reading only the first reported it as unimportable.
  const health =
    (detail as SourceApplication).healthCheck ??
    swarmHealthCheck((detail as SourceApplication).healthCheckSwarm);
  if (health && !isCompose) {
    try {
      await updateAppHealthCheck(created.id, health);
    } catch (e) {
      notes.push(
        `Its health check was not imported: ${e instanceof Error ? e.message : "refused"}. Set one under Advanced.`,
      );
    }
  }

  // The credential comes across AS IT IS. Measured: a code-server arrived online and
  // open because "CoderPass123" has no special character.
  const security = (detail as SourceApplication).security ?? [];
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
    const app = detail as SourceApplication;
    if (app.isPreviewDeploymentsActive) {
      try {
        const { setAppPreviewSettings } = await import("./previews");
        // `*.preview.acme.com` over there is the base `preview.acme.com` here.
        const base = app.previewWildcard?.trim().replace(/^\*\./, "") || null;
        await setAppPreviewSettings(created.id, {
          enabled: true,
          port: app.previewPort ?? null,
          maxActive:
            typeof app.previewLimit === "number" && app.previewLimit > 0
              ? Math.min(app.previewLimit, 50)
              : null,
          ...(base ? { baseDomain: base } : {}),
        });
      } catch (e) {
        notes.push(
          `Preview deployments were on over there but did not come across: ${e instanceof Error ? e.message : "refused"}. Turn them on under Previews.`,
        );
      }
    }
    // Their own variables, as Deplo's own preview variables - a preview inherits
    // the app's, so these are the ones that differ or exist only there.
    const previewVars = parseEnvBlob(app.previewEnv).filter((v) => v.key);
    if (previewVars.length > 0) {
      const { setPreviewEnvVar } = await import("./previews");
      const landed: string[] = [];
      const refused: string[] = [];
      for (const v of previewVars) {
        try {
          await setPreviewEnvVar(
            created.id,
            v.key,
            v.value,
            importedEnvType(v.key),
          );
          landed.push(v.key);
        } catch (e) {
          refused.push(
            `${v.key} (${e instanceof Error ? e.message : "refused"})`,
          );
        }
      }
      if (landed.length > 0)
        notes.push(
          `Preview-only variable(s) came across as this app's preview variables: ${landed.join(", ")}.`,
        );
      if (refused.length > 0)
        notes.push(
          `Preview-only variable(s) that did not come across: ${refused.join("; ")}. Set them under Previews.`,
        );
    }
  }

  await importCrons(
    c,
    isCompose ? "compose" : "application",
    svc.id,
    created.id,
    notes,
    serviceRenames,
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

/** A service name as it landed here: renamed when the import had to move it off a
 *  name the network already answers to. */
function renamedService(
  name: string | null | undefined,
  renames: Map<string, string>,
): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return renames.get(trimmed.toLowerCase()) ?? trimmed;
}

/** Dokploy's schedules for one service → Deplo cron jobs. */
async function importCrons(
  c: SourceCredential,
  scheduleType: "application" | "compose",
  sourceId: string,
  appId: string,
  notes: string[],
  /** Services the import renamed, so a job still runs in its own container. */
  serviceRenames: Map<string, string> = new Map(),
): Promise<void> {
  for (const s of await sourceClient(c).listSchedules(scheduleType, sourceId)) {
    const command = (s.command ?? s.script ?? "").trim();
    if (!command) {
      notes.push(`Cron "${s.name}" has no command on {panel} - not imported.`);
      continue;
    }
    try {
      await createCronJob("app", appId, {
        name: s.name,
        schedule: s.cronExpression,
        command,
        service: renamedService(s.serviceName, serviceRenames),
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
 * One Dokploy database → one Deplo Database.
 */
async function importDatabaseService(
  c: SourceCredential,
  svc: SourceService,
  row: SourceDatabase,
  name: string,
  opts: {
    serverId: string | undefined;
    /** The Environment its apps landed in - and therefore the network it has to
     *  answer on, or `db-<slug>` does not resolve from them (ADR-0028). */
    environmentId: string | null;
    /** Undefined keeps the source's port, null publishes none, a number overrides. */
    exposedPort?: number | null;
    mayExposePorts: boolean;
    sourceIsTargetHost: boolean;
    /** The project it came from, which names a namesake database apart. */
    projectName?: string;
    /** Filled in with `old host -> new host`, for the apps that name it. */
    dbHosts: Map<string, string>;
    /** The panel's backup stores by name (lower-cased), as Deplo destinations. */
    destinations?: Map<string, string>;
  },
  report: Report,
): Promise<void> {
  const { serverId } = opts;
  const mapped = mapDatabase(svc.kind as SourceDbKind, { ...row, name });
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

  // A database's name is one per team here, and "postgres" is in every project
  // over there. The SAME environment is the same database (a second run, which
  // is how newer data comes across); anywhere else it is a namesake, and it
  // gets a name of its own rather than a skip that never copies its data.
  const teamId = await requireActiveTeamId();
  const taken = async (candidate: string) =>
    (
      await getDb()
        .select({
          id: databasesTable.id,
          environmentId: databasesTable.environmentId,
        })
        .from(databasesTable)
        .where(
          and(
            eq(databasesTable.teamId, teamId),
            sql`lower(${databasesTable.name}) = ${candidate.trim().toLowerCase()}`,
          ),
        )
    )[0];
  const clash = await taken(spec.name);
  if (clash && clash.environmentId === opts.environmentId) {
    await report.add({
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: name,
      outcome: "skipped",
      targetKind: "database",
      targetId: clash.id,
      message:
        "A database with this name is already in this environment, so it is the one that is kept - its data is copied again in this same import.",
    });
    return;
  }
  if (clash) {
    const suffix =
      (opts.projectName ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "2";
    const base = `${spec.name.trim()}-${suffix}`;
    let candidate = base;
    for (let n = 2; await taken(candidate); n++) candidate = `${base}-${n}`;
    notes.push(
      `This team already has a database called ${spec.name}, so this one is ${candidate}.`,
    );
    spec.name = candidate;
  }

  // The password is carried over on purpose (see mapDatabase), and as a GENERATED
  // credential: another platform's random token is not something a person chose, so
  // Deplo's account policy does not apply to it.
  const base = {
    name: spec.name,
    type: spec.type,
    version: spec.version,
    serverId,
    environmentId: opts.environmentId,
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
      await sourceClient(c).stopService(svc.kind, svc.id);
      // Written down like the data phase's own stops: backing out starts again
      // exactly what Deplo stopped, and this one used to be forgotten.
      if (report.id)
        await getDb()
          .update(targetsTable)
          .set({ stoppedKind: svc.kind, stoppedAt: nowIso() })
          .where(
            and(
              eq(targetsTable.runId, report.id),
              eq(targetsTable.serviceId, svc.id),
            ),
          );
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

  // Its backup schedules, onto the destination that came across with them. One
  // that saves somewhere Deplo has no store for stays a note - a bucket with no
  // schedule reads as a choice unless this says otherwise.
  const schedules = (row.backups ?? []).filter(
    (b) => b?.enabled !== false && b.schedule?.trim(),
  );
  if (schedules.length > 0) {
    const { createBackup } = await import("./backups");
    for (const b of schedules) {
      const destName = b.destination?.name?.trim() ?? "";
      const destinationId = destName
        ? opts.destinations?.get(destName.toLowerCase())
        : undefined;
      const where = `${b.schedule!.trim()}${destName ? ` to ${destName}` : ""}`;
      if (!destinationId) {
        notes.push(
          `Backed up on {panel} (${where}), but that destination is not here, so no schedule was set - set one under Backups.`,
        );
        continue;
      }
      try {
        await createBackup({
          name: `${spec.name} to ${destName}`,
          databaseId: created.id,
          destinationId,
          schedule: b.schedule!.trim(),
          retentionCount:
            typeof b.keepLatestCount === "number" && b.keepLatestCount > 0
              ? b.keepLatestCount
              : 7,
        });
        notes.push(`Its backup schedule came across: ${where}.`);
      } catch (e) {
        notes.push(
          `Backed up on {panel} (${where}); the schedule was not set here: ${
            e instanceof Error ? e.message : "refused"
          }. Set one under Backups.`,
        );
      }
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
  // Both names an app can reach it by: the container's label (Dokploy) and the
  // service's own id, which is what Coolify hands out as the internal URL.
  for (const from of [row.appName, svc.id])
    if (from?.trim()) {
      opts.dbHosts.set(from.trim(), created.host);
      if (report.id)
        await getDb()
          .insert(dbHostsTable)
          .values({
            runId: report.id,
            sourceHost: from.trim(),
            targetHost: created.host,
            environmentId: opts.environmentId,
          })
          .onConflictDoUpdate({
            target: [dbHostsTable.runId, dbHostsTable.sourceHost],
            set: {
              targetHost: created.host,
              environmentId: opts.environmentId,
            },
          });
    }
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
 * A Dokploy project's or environment's own env blob → a Deplo shared variable per
 * key, scoped there AND linked to the apps that were in it.
 */
/**
 * The S3 stores the panel backed up to, as Deplo's own destinations. Tried at
 * once, exactly as a hand-made one is: a credential that stopped working over
 * there should say so now, not at the first backup that needed it.
 */
async function importBackupDestinations(
  c: SourceCredential,
  report: Report,
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let stores: Awaited<
    ReturnType<MigrationSourceClient["listBackupDestinations"]>
  >;
  try {
    stores = await sourceClient(c).listBackupDestinations();
  } catch (e) {
    // Said, not swallowed: every schedule below then reads "that destination is
    // not here" with no line saying why.
    await report.add({
      sourceKind: "destination",
      sourceName: "backup destinations",
      outcome: "manual",
      targetKind: "destination",
      message: `{panel} would not answer for its backup stores (${e instanceof Error ? e.message : "refused"}), so no backup destination came across. Add it under Backups, then the schedules.`,
    });
    return byName;
  }
  if (stores.length === 0) return byName;

  const { createDestination, listDestinations, testDestination } =
    await import("./destinations");
  // The bucket is the identity: a store already here under any name is the one
  // the panel's schedules meant, so its name here answers for the panel's.
  const existing = new Map<string, string>(
    (await listDestinations()).map((d) => [
      `${(d.endpoint ?? "").toLowerCase()}|${d.bucket ?? ""}`,
      d.id,
    ]),
  );

  for (const store of stores) {
    const key = `${store.endpoint.toLowerCase()}|${store.bucket}`;
    const already = existing.get(key);
    if (already) {
      byName.set(store.name.toLowerCase(), already);
      await report.add({
        sourceKind: "destination",
        sourceName: store.name,
        outcome: "skipped",
        targetKind: "destination",
        message:
          "A backup destination for that bucket is already in this team.",
      });
      continue;
    }
    try {
      const created = await createDestination({
        name: store.name,
        kind: "s3",
        endpoint: store.endpoint,
        region: store.region,
        bucket: store.bucket,
        accessKey: store.accessKeyId,
        secretKey: store.secretAccessKey,
      });
      existing.set(key, created.id);
      byName.set(store.name.toLowerCase(), created.id);
      let failure: string | null = null;
      try {
        const { report: probe } = await testDestination(created.id);
        failure = probe.ok ? null : probe.error || "it did not answer";
      } catch (e) {
        failure = e instanceof Error ? e.message : "the test did not run";
      }
      await report.add({
        sourceKind: "destination",
        sourceName: store.name,
        outcome: failure ? "manual" : "created",
        targetKind: "destination",
        targetId: created.id,
        message: failure
          ? `It came across, but it did not answer: ${failure}. Those credentials were already dead on {panel} - fix them under Backups.`
          : null,
      });
    } catch (e) {
      await report.add({
        sourceKind: "destination",
        sourceName: store.name,
        outcome: "failed",
        targetKind: "destination",
        message: e instanceof Error ? e.message : "Could not be created.",
      });
    }
  }
  return byName;
}

/**
 * Every shared variable an app of this import can be linked to, by KEY: the row a
 * link points at, and the value a reference to it stands for. Flat, because Deplo
 * keeps one shared variable per team and name - so the FIRST level that carries a
 * key wins, exactly as the database already decides on a re-run.
 * `ponytail: first-level-wins; compare values if a report line naming the winner is asked for.`
 */
type SharedIndex = Map<string, { varId: string; value: string }>;

async function importSharedVars(
  blob: string | null | undefined,
  opts: {
    teamId: string;
    label: string;
    environmentIds: string[];
    projectIds: string[];
    /** The scope the variable SUGGESTS. Only a REFERENCE creates a link. */
    teamWide?: boolean;
    /** Said in the created line when the level has no twin here. */
    scopeNote?: string;
    report: Report;
  },
  /** Filled in as variables land, so an app can be linked to one afterwards. */
  index: SharedIndex,
): Promise<void> {
  const entries = parseEnvBlob(blob);
  if (entries.length === 0) return;

  // Same rule as everything else on a re-run: a key that is already here is left
  // exactly as it is - but it still enters the index, so the apps that referenced
  // it are linked to the row that IS here.
  const already = await visibleSharedVarIdsByKey(opts.teamId);

  for (const { key, value } of entries) {
    if (index.has(key)) continue;
    const here = already.get(key);
    if (here) {
      index.set(key, { varId: here, value });
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "skipped",
        targetKind: "shared-var",
        message:
          "A shared variable with this name is already in this team. The apps that referenced it are linked to that one, whatever value it holds.",
      });
      continue;
    }
    try {
      const varId = await saveSharedVar({
        key,
        value,
        type: importedEnvType(key),
        teamIds: opts.teamWide ? [opts.teamId] : [],
        environmentIds: opts.environmentIds,
        projectIds: opts.projectIds,
        // Never `[]`, which is a whole-set replace that would unlink what a
        // previous pass attached. Links are made from the REFERENCES, below.
        appIds: undefined,
      });
      index.set(key, { varId, value });
      await opts.report.add({
        path: opts.label,
        sourceKind: "shared-var",
        sourceName: key,
        outcome: "created",
        targetKind: "shared-var",
        message:
          (opts.scopeNote ? `${opts.scopeNote} ` : "") +
          "Only an app that referenced it on {panel} is linked to it - link others under Variables.",
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
 * Deplo's.
 */
export async function importMigrationMembers(
  input: ConnectInput & { runId: string },
): Promise<MigrationInvite[]> {
  const { teamId } = await assertImportGate();
  await requireInstanceAdmin();
  const c = await credentialFor(input);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  // The name, not the placeholder: these lines are handed back to the wizard as
  // well as written to the report, and only the report resolves a `{panel}`.
  const panel = sourceClient(c).displayName;
  const report = new Report(input.runId, panel).at("Members");
  const people = await planMembers(c, teamId);
  const out: MigrationInvite[] = [];

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
        ? ` Was ${p.sourceRole} on ${panel} - promote them in Members if that should carry over.`
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
export async function stopMigration(runId: string): Promise<void> {
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
  await undoMigration(runId);
}

/**
 * Take a run back out whole: what it created HERE, and the agent Deplo put over
 * THERE to read it. The uninstall is FORCED past its usual guard.
 */
export async function undoMigration(
  runId: string,
  /** The uninstall past its usual guard. A person taking everything back out has
   *  no further use for the source; the AUTOMATIC revert after a failure does -
   *  it took the agent off a machine the next attempt then could not read. */
  opts: { forceSourceRemoval?: boolean } = {},
): Promise<void> {
  const { teamId } = await assertImportGate();
  await releaseMigrating(runId);
  await revertMigration(runId, { undo: true });
  await removeMigrationSources(runId, teamId, {
    force: opts.forceSourceRemoval !== false,
  });
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
export async function revertMigration(
  runId: string,
  /** `undo: true` is the automatic path (a Stop, a failed run). There, a run that
   *  is already out is nothing left to do; asked for by hand, it is worth saying. */
  opts: { undo?: boolean } = {},
): Promise<RevertResultDTO> {
  return runAsMigration(() => runRevertMigration(runId, opts));
}

async function runRevertMigration(
  runId: string,
  opts: { undo?: boolean },
): Promise<RevertResultDTO> {
  const { teamId } = await assertImportGate();
  const [run] = await getDb()
    .select({ status: runsTable.status })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)))
    .limit(1);
  if (!run) throw new Error("Migration not found");
  // Everything is already gone, so a second pass would report every one of them
  // as a thing it could not remove.
  if (run.status === "reverted") {
    if (!opts.undo) throw new Error("This import was already taken back out.");
    return {
      apps: 0,
      databases: 0,
      environments: 0,
      projects: 0,
      sharedVars: 0,
      failed: [],
    };
  }

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
    await appendRunItem(runId, "the panel", {
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
export async function resumableMigration(): Promise<ImportRunDTO | null> {
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
  return row ? (await toRunDTOs([row]))[0] : null;
}

/**
 * {@link resumableMigration} across every team this person is in: the page is
 * the instance's, and the run it should open on may have landed in any of them.
 */
export async function resumableMigrationAnywhere(): Promise<ImportRunDTO | null> {
  await requireInstanceAdmin();
  const user = await getCurrentUser();
  if (!user) return null;
  const mine = (await teamsForUser(user.id)).map((t) => t.id);
  if (mine.length === 0) return null;
  const [row] = await getDb()
    .select()
    .from(runsTable)
    .where(
      and(
        inArray(runsTable.teamId, mine),
        isNull(runsTable.reportSeenAt),
        or(eq(runsTable.actorUserId, user.id), eq(runsTable.status, "running")),
      ),
    )
    .orderBy(desc(runsTable.seq))
    .limit(1);
  return row ? (await toRunDTOs([row]))[0] : null;
}

/**
 * "I am done looking at this run" - the wizard stops opening on it.
 */
export async function dismissMigrationReport(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  await getDb()
    .update(runsTable)
    .set({ reportSeenAt: nowIso() })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
}

/**
 * The team's migration in flight, or null. There is at most one: opening a run
 * marks any older `running` row of the team Interrupted (see {@link
 * beginMigration}), so this is a fact, not a first-of-many.
 */
export async function activeMigrationForTeam(
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
  const [dto] = await toRunDTOs([rows[0]]);
  return { ...dto, lastPath: last?.path ?? null };
}

export async function listMigrationRuns(): Promise<ImportRunDTO[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.teamId, teamId));
  return toRunDTOs(newestFirst(rows));
}

/** Every team's migrations: the instance's history, for its admins. */
export async function listAllMigrationRuns(): Promise<ImportRunDTO[]> {
  await requireInstanceAdmin();
  const rows = await getDb().select().from(runsTable);
  return toRunDTOs(newestFirst(rows));
}

function newestFirst<T extends { startedAt: string; seq: number }>(
  rows: T[],
): T[] {
  return rows.sort((a, b) =>
    a.startedAt === b.startedAt
      ? b.seq - a.seq
      : a.startedAt < b.startedAt
        ? 1
        : -1,
  );
}

export async function getMigrationRun(
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
  const [dto] = await toRunDTOs([rows[0]]);
  return {
    ...dto,
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

/** What the History table draws before a name. */
interface ActorFace {
  username: string | null;
  avatarUrl: string | null;
  avatarColor: string | null;
}

/**
 * Resolve every run's actor in one query, so a page of history is two reads and
 * not one per row. Email is read only to feed the Gravatar fallback and dropped.
 */
async function actorFaces(
  rows: (typeof runsTable.$inferSelect)[],
): Promise<Map<string, ActorFace>> {
  const ids = [
    ...new Set(
      rows.map((r) => r.actorUserId).filter((v): v is string => Boolean(v)),
    ),
  ];
  if (ids.length === 0) return new Map();
  const people = await getDb()
    .select({
      id: usersTable.id,
      username: usersTable.username,
      avatarColor: usersTable.avatarColor,
      image: usersTable.image,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(inArray(usersTable.id, ids));
  const url = await avatarResolver();
  return new Map(
    people.map((p) => [
      p.id,
      {
        username: p.username,
        avatarColor: p.avatarColor,
        avatarUrl: url(p),
      },
    ]),
  );
}

/** The same rows as DTOs, with their actors' faces attached. */
async function toRunDTOs(
  rows: (typeof runsTable.$inferSelect)[],
): Promise<ImportRunDTO[]> {
  const [faces, homes] = await Promise.all([actorFaces(rows), teamsOf(rows)]);
  return rows.map((r) =>
    toRunDTO(
      r,
      (r.actorUserId && faces.get(r.actorUserId)) || null,
      homes.get(r.teamId) ?? null,
    ),
  );
}

/** The teams these runs landed in, one read for the whole list. */
async function teamsOf(
  rows: { teamId: string }[],
): Promise<Map<string, { name: string; slug: string; image: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.teamId))];
  if (ids.length === 0) return new Map();
  const found = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
      image: teamsTable.image,
    })
    .from(teamsTable)
    .where(inArray(teamsTable.id, ids));
  return new Map(found.map((t) => [t.id, t]));
}

function toRunDTO(
  r: typeof runsTable.$inferSelect,
  face: ActorFace | null,
  home: { name: string; slug: string; image: string | null } | null,
): ImportRunDTO {
  return {
    id: r.id,
    teamId: r.teamId,
    teamName: home?.name ?? "",
    teamSlug: home?.slug ?? "",
    teamAvatarUrl: deploTeamAvatarUrl(home?.image),
    platform: isMigrationPlatform(r.platform) ? r.platform : "dokploy",
    sourceUrl: r.sourceUrl,
    orgName: r.orgName,
    actor: r.actor,
    actorUsername: face?.username ?? null,
    actorAvatarUrl: face?.avatarUrl ?? null,
    actorAvatarColor: face?.avatarColor ?? null,
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
