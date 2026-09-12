import "server-only";

import { healthCheckProblem } from "../apps/health-check-model";

import { cache } from "@/lib/request-cache";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import {
  listAllServers,
  listServersForTeam,
  getServerById,
  assertServerAccessibleTx,
  canHostWorkloads,
} from "./servers";
import { getDb } from "../db/client";
import {
  domains as domainsTable,
  apps as appsTable,
  pendingTeardowns as pendingTeardownsTable,
  appBuild as appBuildTable,
  appBuildMethodSettings as appBuildMethodSettingsTable,
  appMounts as appMountsTable,
  appPorts as appPortsTable,
  appVolumes as appVolumesTable,
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
  teamAppOrder,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import {
  currentMemberScope,
  requireActiveTeamId,
  requireCapability,
  requireExposePorts,
  requireMembership,
  requireMountHostVolumes,
  isInstanceAdmin,
  requireTeamWide,
} from "../membership";
import {
  composeClaimsReservedName,
  composeHostReach,
  composeInterpolatedHostname,
  composePublishesPorts,
  composeUsesExternalMerge,
  externalMergeMessage,
  interpolatedHostnameMessage,
  isReservedSharedName,
  reservedNameMessage,
  assertComposeWithinLimits,
} from "../deploy/compose-lint";
import { hostPortClaimed } from "./host-ports";
import { appOwnVolumeNames } from "./project-backup-descriptor";
import {
  assertNoNameClash,
  namesOnNetwork,
  namesTakenOnNetwork,
  withNetworkLock,
} from "./name-clash";
import { renameClashingServices, renameHostTokens } from "../migration/map";
import { appSlugFromDeployKey, stackName } from "../deploy/deploy-key";
import {
  composeNamesOnNetwork,
  composeServiceNames,
  composeServicePort,
} from "../deploy/compose-stack";
import {
  parseComposeUpArgs,
  validateComposeUpArgs,
} from "../deploy/compose-args";
import {
  kindOf,
  reservedMountPath,
  VOLUME_NAME_MAX,
  VOLUME_NAME_RE,
} from "../apps/volume-model";
import {
  DEFAULT_ROLLBACK_KEEP,
  MAX_PUBLISHED_PORTS,
  MAX_ROLLBACK_KEEP,
  MOUNT_PROPAGATIONS,
} from "../types";
import { MAX_PORT, MIN_USER_PORT, isValidExposePort } from "../databases/ports";
import { encryptSecret } from "../crypto";
import type { EnvEntryType } from "../deploy/env-resolve";
import { recordActivity } from "./activity";
import { markPendingChanges } from "./pending-changes";
import { setSharedVarAppLink } from "./shared-vars";
import { teardownOrQueue } from "./teardown-queue";
import { matchesQuery } from "../match-query";
import { imageExposedPort } from "../registry/client";
import { buildConfigFor } from "../frameworks";
import type {
  App,
  AppStatus,
  BuildConfig,
  BuildMethod,
  Capability,
  DeploySource,
  Deployment,
  EnvTarget,
  EnvVar,
  GitRepo,
  HealthCheck,
  PublishedPort,
  ResourceLimits,
  UploadArchive,
  VolumeMount,
} from "../types";
import { mapLimit, usesComposeStack } from "../utils";
import {
  startDeployment,
  stopContainer,
  startContainer,
  rerouteApp,
} from "../deploy/build";
import {
  ensureAutoDomain,
  ensureExtraDomain,
  isHostnameClaim,
} from "./domains";
import { requireFolderCapability } from "./folder-access";
import { defaultEnvironmentFor } from "./projects";
import {
  resolveServerIp,
  productionDomain,
  instanceHost,
  rehostNip,
  rehostBlueprintHosts,
  nipEmbeddedIp,
  blueprintWantsTls,
} from "../deploy/domains";
import { redeploy } from "./deployments";
import { descendantFolderIds } from "./folders";
import {
  destroyPreviewsForApp,
  stopPreviewsForServerChange,
} from "../deploy/preview-lifecycle";
import { withKeyedLock } from "./keyed-mutex";
import { removeUploads } from "../deploy/upload";
import { isValidLogoValue } from "../apps/logo-shared";
import { logoToneFromDataUri } from "../apps/logo-tone";
import { detectAppFavicon } from "../apps/favicon-detect";
import { faviconSourceKind } from "../apps/favicon-shared";
import { getTemplateBlueprint } from "../templates-blueprint";
import { DEFAULT_VARIANT_SLUG } from "@/templates/types";
import { getTemplateVariant, templateLogoDataUri } from "@/templates/catalog";
import {
  detectRepoFramework,
  type RepoBuildHints,
} from "../apps/framework-source";
import {
  frameworkById,
  isFrameworkId,
  supportsFrameworkDetection,
} from "../apps/framework-catalog";
import { listGithubInstallations } from "./github";
import {
  dropAppWebhook,
  gitConnectionInTeam,
  syncAppWebhook,
} from "./git-connections";
import {
  AgentUnreachableError,
  BACKUP_RUN_MAX_MS,
} from "../infra/agent-client";
import { publishAppChanged } from "../graphql/pubsub";
import {
  inAppScope,
  inFolderScope,
  inProjectScope,
} from "../auth/request-context";
import { appInScope, folderInScope } from "./node-scope";
import {
  insertEnvVars,
  loadDomainsForApp,
  loadAppGraph,
  loadAppGraphBySlug,
  loadAppsByIds,
  loadAppsByTeam,
  loadTeamApp,
  preloadSummaries,
  appInTeam,
  appSourceInTeam,
  type SummaryPreload,
} from "./app-graph-load";
import {
  buildToRow,
  methodSettingsToRow,
  mountsToRows,
  portsToRows,
  appToRow,
  resourceLimitsToRow,
  healthCheckToRow,
  volumesToRows,
} from "./app-graph-rows";
import { detectDefaultApp } from "../deploy/compose-stack";
import {
  appCapabilities,
  appCapabilitiesForTeam,
  hasAppCapability,
  nodeCapabilitiesFor,
  requireAppCapability,
  requireNodeCapability,
} from "./node-access";
import { assertDataCopyIntact } from "./data-copy";

/**
 * True if `err` is a Postgres unique-violation (SQLSTATE 23505) on the named
 * constraint. Drizzle wraps the driver error; the original is on `.cause`, and
 * both node-postgres and pglite expose `.code` + `.constraint` (or the
 * constraint name in the message). Used to retry the optimistic slug pick.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const o = e as { code?: string; constraint?: string; message?: string };
    if (o.code === "23505") {
      return (
        o.constraint === constraint ||
        (o.message?.includes(constraint) ?? false)
      );
    }
  }
  return false;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface AppSummary extends App {
  latestDeployment: Deployment | null;
  domainCount: number;
  /**
   * What the CURRENT caller may do to this app (node grants included) - carried
   * on the list so the Overview grid can grey out an action the server would
   * refuse, without asking per card. Absent on the engine paths that summarize
   * without a caller; treat that as "unknown", never as "denied".
   */
  capabilities?: Capability[];
}

import { deriveVolumeName } from "../apps/volume-model";
import { assertCloneTargetSafe } from "../git/clone-url";

export { deriveVolumeName };

/**
 * "stopping" is transient (≤60s): a crash mid-stop would wedge it forever, so a
 * stale one reads as "idle". The row is not rewritten - the next real change is.
 */
const STOPPING_STALE_MS = 90_000;

/**
 * "restoring" heals to "error", not "idle", past the agent's own backup ceiling:
 * a half-restored app is broken, not stopped on purpose. Telemetry promotes it
 * back to "active" once the host says the containers are up.
 */
const RESTORING_STALE_MS = BACKUP_RUN_MAX_MS;

/**
 * Why nothing of ours may run OR build on a MIGRATION SOURCE. It is the one
 * specialised role that has Docker - it is the other platform's own host - so
 * every "can this machine build?" check that reads `storageOnly` alone would
 * happily send this app's source and its DECRYPTED env there.
 */
const ON_IMPORT_SOURCE =
  "That server is a migration source - it only exists to import from another platform.";

/**
 * Map a project's persisted status to the status callers should see, self-
 * healing a wedged transient state. Exported for unit tests; pure (no
 * store/docker).
 */
export function reconcileStatus(
  status: AppStatus,
  updatedAt: string,
  now: number = Date.now(),
): AppStatus {
  const age = now - new Date(updatedAt).getTime();
  if (status === "stopping")
    return age > STOPPING_STALE_MS ? "idle" : "stopping";
  if (status === "restoring")
    return age > RESTORING_STALE_MS ? "error" : "restoring";
  return status;
}

/**
 * Fold an app into an {@link AppSummary} - PURE over preloaded deployment and
 * domain maps, so N apps cost one batch load, not N round-trips.
 */
function summarize(p: App, pre: SummaryPreload): AppSummary {
  const status = reconcileStatus(p.status, p.updatedAt);
  return {
    ...p,
    status,
    // Apps created before the logo field have it absent; surface an explicit
    // null so every consumer reads a defined `string | null`.
    logo: p.logo ?? null,
    // Same for the folder grouping: absent (pre-folders) ⇒ ungrouped (null).
    folderId: p.folderId ?? null,
    latestDeployment: p.latestDeploymentId
      ? (pre.latestDeployments.get(p.latestDeploymentId) ?? null)
      : null,
    domainCount: pre.domainCounts.get(p.id) ?? 0,
  };
}

/**
 * Update a team-owned project's flat columns, throwing "App not found" when
 * the id doesn't belong to the team (the standard ownership gate, now a single
 * team-scoped UPDATE … RETURNING instead of a find-then-mutate).
 */
async function updateAppOwned(
  id: string,
  teamId: string,
  set: Partial<typeof appsTable.$inferInsert>,
): Promise<void> {
  const updated = await getDb()
    .update(appsTable)
    .set(set)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
}

/** Team-wide manual project order (the `team_app_order` junction), id→rank. */
async function appOrderRank(teamId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ appId: teamAppOrder.appId, position: teamAppOrder.position })
    .from(teamAppOrder)
    .where(eq(teamAppOrder.teamId, teamId));
  return new Map(rows.map((r) => [r.appId, r.position] as const));
}

/**
 * Every app in the active team, newest first (or the team's manual order).
 * `query` matches name, slug or id - the same match `search` uses. Filtered here
 * rather than in SQL so the scope and folder gates below stay untouched.
 */
export async function listApps(query?: string): Promise<AppSummary[]> {
  const teamId = await requireActiveTeamId();
  const [all, rank] = await Promise.all([
    loadAppsByTeam(teamId),
    appOrderRank(teamId),
  ]);
  // `loadAppsByTeam` is an engine primitive and must never filter itself - a
  // token's project scope applies HERE, where the answer is a user-facing list.
  // A stamped app (`deleting_at`) is refused everywhere else, so it is not listed.
  const scoped = all.filter((p) => inAppScope(p) && !p.deletingAt);
  // …and so is per-app access: an app the caller holds nothing on is not theirs
  // to list. One batched resolution for the team. A narrowed token is NOT exempt
  // - the clamp that justified the exemption is fixed in `holdsManageTeam`.
  const reach = await appCapabilitiesForTeam(
    teamId,
    scoped.map((p) => ({
      id: p.id,
      folderId: p.folderId ?? null,
      projectId: p.projectId ?? null,
      environmentId: p.environmentId ?? null,
    })),
  );
  const proj = scoped.filter((p) => (reach.get(p.id)?.length ?? 0) > 0);
  const hits = query
    ? proj.filter((p) => matchesQuery(query, p.name, p.slug, p.id))
    : proj;
  const pre = await preloadSummaries(hits);
  // Honour the team's manual order (Overview drag-and-drop) when present:
  // explicitly-ordered apps come first in that order, anything not listed
  // (a brand-new project, or before any reorder) falls back to newest-first.
  return hits
    .map((p) => ({ ...summarize(p, pre), capabilities: reach.get(p.id) }))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
}

/**
 * Persist the team-wide order of the Overview grid - one arrangement for every
 * member, so it is gated like a team setting. Unknown ids are dropped and omitted
 * apps appended, so the stored order stays total.
 */
export async function reorderApps(orderedIds: string[]): Promise<void> {
  const teamId = await requireActiveTeamId();
  // A team-wide arrangement is not something a project-scoped token rewrites,
  // and this is the one gate an instance admin bypasses, so the clamp on
  // `manage_team` wouldn't have covered it.
  await requireTeamWide("the team-wide app order");
  // Instance admins bypass team capabilities; everyone else needs manage_team.
  if (!(await isInstanceAdmin())) {
    await requireCapability("manage_team");
  }
  await getDb().transaction(async (tx) => {
    const teamAppIds = (
      await tx
        .select({ id: appsTable.id })
        .from(appsTable)
        .where(eq(appsTable.teamId, teamId))
    ).map((r) => r.id);
    const valid = new Set(teamAppIds);
    const seen = new Set<string>();
    const next: string[] = [];
    for (const id of orderedIds) {
      if (valid.has(id) && !seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    }
    for (const id of teamAppIds) if (!seen.has(id)) next.push(id);
    // Whole-set replace: drop the team's order rows, re-insert in the new order.
    await tx.delete(teamAppOrder).where(eq(teamAppOrder.teamId, teamId));
    if (next.length > 0) {
      await tx
        .insert(teamAppOrder)
        .values(next.map((appId, position) => ({ teamId, appId, position })));
    }
  });
}

/** Summarize a single already-loaded project (its own bounded preload). */
async function summarizeOne(p: App): Promise<AppSummary> {
  const pre = await preloadSummaries([p]);
  return summarize(p, pre);
}

// React-cached so a request that reads the same project twice - e.g. the project
// layout's generateMetadata AND its render - only hits the DB once per request.
export const getAppBySlug = cache(async function getAppBySlug(
  slug: string,
): Promise<AppSummary | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadAppGraphBySlug(slug);
  return p && p.teamId === teamId && inAppScope(p) && (await canReachApp(p.id))
    ? summarizeOne(p)
    : null;
});

export async function getAppById(id: string): Promise<App | null> {
  const p = await loadTeamApp(id, await requireActiveTeamId());
  return p && (await canReachApp(p.id)) ? p : null;
}

/**
 * Whether the caller holds ANYTHING on this app. An empty set means no section of
 * it is readable, so this one guard is what keeps an app in a folder they cannot
 * see out of the whole UI.
 */
async function canReachApp(id: string): Promise<boolean> {
  return (await appCapabilities(id)).length > 0;
}

/**
 * The cookie-free twin of {@link canReachApp}, for the subscription seams:
 * `getCurrentUser()` reads cookies, which is not callable across the async ticks
 * of a long-lived SSE response, so the principal is passed in.
 */
async function reachableByUser(
  userId: string,
  teamId: string,
  appId: string,
): Promise<boolean> {
  return (
    (await nodeCapabilitiesFor(userId, teamId, { kind: "app", id: appId }))
      .length > 0
  );
}

/**
 * App summary by id for an already-resolved team and principal, WITHOUT cookies -
 * `cookies()` is not callable across the ticks of an SSE response. Keeps
 * `getAppBySlug`'s folder gate, or the live feed is the way around folder privacy.
 */
export async function summarizeForTeam(
  id: string,
  teamId: string,
  userId: string,
): Promise<AppSummary | null> {
  const p = await loadAppGraph(id);
  return p &&
    p.teamId === teamId &&
    inAppScope(p) &&
    (await reachableByUser(userId, teamId, p.id))
    ? summarizeOne(p)
    : null;
}

/** Cookie-free slug → summary lookup scoped to an explicit team (see above). */
export async function findAppSummaryBySlugForTeam(
  slug: string,
  teamId: string,
  userId: string,
): Promise<AppSummary | null> {
  const p = await loadAppGraphBySlug(slug);
  return p &&
    p.teamId === teamId &&
    inAppScope(p) &&
    (await reachableByUser(userId, teamId, p.id))
    ? summarizeOne(p)
    : null;
}

export interface CreateAppInput {
  name: string;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage?: string | null;
  /** Display logo (URL/path), defaulted from a template's logo on deploy. */
  logo?: string | null;
  /** The logo above is a template's own, not the caller's: it earns the plate
   *  that keeps a monochrome mark visible on both themes. */
  logoFromTemplate?: boolean;
  compose?: string | null;
  /** Initial variables. `type` omitted is `plain`: nothing is typed secret on
   *  the caller's behalf, because a secret can never be edited afterwards. */
  env?: { key: string; value: string; type?: EnvEntryType }[];
  serverId?: string;
  /**
   * Where the app COMPILES, when that is not where it runs. Null is Automatic.
   * Here for a BULK IMPORT, where placing thirty apps is the whole screen.
   */
  buildServerId?: string | null;
  build?: Partial<BuildConfig>;
  autoDeploy?: boolean;
  /** Compose/template deploys: which service + port the PRIMARY domain routes
   * to. When absent for a compose project, detectDefaultApp picks one. */
  composeService?: string | null;
  composePort?: number | null;
  /** A multi-domain template's EXTRA (non-primary) routed hosts - each becomes
   * its own auto Domain row at creation (the primary is the `autoDomain`). The
   * `domains` table is the sole routing source afterward; there is no `exposes`. */
  extraDomains?:
    | { service: string; port: number; host: string; path?: string | null }[]
    | null;
  /** Pre-generated PRIMARY domain a template baked into its env; kept consistent. */
  autoDomain?: string | null;
  /** The path {@link autoDomain} routes here. An import brings apps that share one
   *  hostname on different paths; without it the second one is refused the name. */
  autoDomainPath?: string | null;
  /**
   * Create the app with NO address at all. An IMPORT is the one caller that knows
   * a worker or a queue consumer wants no public URL invented for it.
   */
  noAutoDomain?: boolean;
  /** Template config files to materialise at deploy time. */
  mounts?: { filePath: string; content: string }[] | null;
  /**
   * The compose was generated by Deplo (a template), so a service whose name a
   * neighbour already answers is renamed, like an import, instead of refused.
   */
  renameClashes?: boolean;
  /** Extra flags for `docker compose up`, validated like the app setting. */
  composeUpArgs?: string | null;
  /**
   * Shared variables linked to the app AT BIRTH, so the first deploy already
   * carries them. Linking after the create would be too late: `createApp`
   * starts that deploy itself.
   */
  sharedVarIds?: string[] | null;
  /** WHERE the app is born. The Overview drill-ins (an open folder, or a
   *  project's selected environment) thread their context through `/new`, so an
   *  app created while standing inside a folder lands IN that folder instead of
   *  at the team top level. Omitted ⇒ top level. See {@link resolveNewAppPlacement}. */
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  /** Start the first deployment. Defaults to true; false leaves the app idle. */
  deploy?: boolean;
}

export interface CreateAppFromTemplateInput {
  templateSlug: string;
  variantSlug?: string;
  name?: string;
  serverId?: string;
  projectId?: string;
  environmentId?: string;
  folderId?: string;
  deploy?: boolean;
}

/**
 * Resolve (and authorize) where a brand-new app is filed. ADR-0009: one place
 * only, and a folder wins over a project. Authorized exactly like a MOVE into the
 * same destination, or creating would smuggle an app into a foreign folder.
 */
async function resolveNewAppPlacement(
  input: CreateAppInput,
  teamId: string,
): Promise<{
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
}> {
  const placement = await resolvePlacement(input, teamId);
  // A caller who reaches part of the team creates INSIDE that part or not at all.
  // Which question to ask depends on the destination: a FOLDER has no
  // `project_id`, and asking about the project refused them their own folder.
  const roleScope = await currentMemberScope();
  if (placement.folderId) {
    if (
      !inFolderScope(placement.folderId) ||
      !folderInScope(roleScope, placement.folderId)
    )
      throw new Error("Folder not found");
  } else if (
    !inProjectScope(placement.projectId) ||
    !appInScope(roleScope, {
      id: "",
      folderId: null,
      projectId: placement.projectId,
      environmentId: placement.environmentId,
    })
  ) {
    throw new Error("Project not found");
  }
  return placement;
}

async function resolvePlacement(
  input: CreateAppInput,
  teamId: string,
): Promise<{
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
}> {
  if (input.folderId) {
    const f = (
      await getDb()
        .select({ id: foldersTable.id })
        .from(foldersTable)
        .where(
          and(
            eq(foldersTable.id, input.folderId),
            eq(foldersTable.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    if (!f) throw new Error("Folder not found");
    await requireFolderCapability(f.id, "create_apps");
    return { folderId: f.id, projectId: null, environmentId: null };
  }
  if (input.environmentId) {
    const env = (
      await getDb()
        .select({
          id: environmentsTable.id,
          projectId: environmentsTable.projectId,
          teamId: projectsTable.teamId,
        })
        .from(environmentsTable)
        .innerJoin(
          projectsTable,
          eq(environmentsTable.projectId, projectsTable.id),
        )
        .where(eq(environmentsTable.id, input.environmentId))
        .limit(1)
    )[0];
    if (!env || env.teamId !== teamId) throw new Error("Environment not found");
    // An explicitly passed project must agree with the environment it names -
    // a mismatched pair is a bug (or a crafted payload), never a placement.
    if (input.projectId && input.projectId !== env.projectId)
      throw new Error("Environment not found");
    await requireNodeCapability(
      { kind: "project", id: env.projectId },
      "create_apps",
    );
    return { folderId: null, projectId: env.projectId, environmentId: env.id };
  }
  if (input.projectId) {
    const p = (
      await getDb()
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(
          and(
            eq(projectsTable.id, input.projectId),
            eq(projectsTable.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    if (!p) throw new Error("Project not found");
    await requireNodeCapability({ kind: "project", id: p.id }, "create_apps");
    // No environment named: land in the project's default one, same as a move.
    const env = await defaultEnvironmentFor(p.id);
    return { folderId: null, projectId: p.id, environmentId: env?.id ?? null };
  }
  // The team top level belongs to no node: only the team-wide set reaches it.
  await requireCapability("create_apps");
  return { folderId: null, projectId: null, environmentId: null };
}

/** An env-var name: same grammar env.ts (`upsertEnv`/`renameEnv`) enforces.
 *  Validated here too so the createApp path can't smuggle a key with newlines /
 *  quotes into the string-templated compose env block (`build.ts` renderCompose). */
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;
/** A docker image reference the compose can carry as a plain YAML scalar. Mirrors
 *  the guard the database path already applies (`databases.ts` isValidImageRef):
 *  anything with whitespace / quotes / YAML metacharacters is rejected, since an
 *  image ref never legitimately contains them and `image: ${ref}` is unquoted. */
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;
/** Cap the app name like Project/Folder/Environment do (they route through
 *  `cleanName`), so a multi-MB name can't bloat every RSC payload / activity row. */
const APP_NAME_MAX = 60;

function cleanAppName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("App name is required.");
  if (trimmed.length > APP_NAME_MAX)
    throw new Error(`App name must be ${APP_NAME_MAX} characters or fewer.`);
  return trimmed;
}

/** One service name a stack would share with a neighbour, and its way out. */
export interface ComposeNameClash {
  name: string;
  /** The app or database already answering to it. */
  owner: string;
  /** What `createApp({ renameClashes: true })` would call it instead. */
  renamedTo: string;
}

/**
 * What `createApp` would refuse this stack over, said BEFORE it is asked - so the
 * wizard can offer the rename instead of surfacing the refusal.
 */
export async function composeNameClashes(
  input: Pick<
    CreateAppInput,
    "compose" | "serverId" | "folderId" | "projectId" | "environmentId"
  >,
): Promise<ComposeNameClash[]> {
  const { teamId } = await requireCapability("create_apps");
  const compose = input.compose?.trim();
  if (!compose) return [];
  const placement = await resolvePlacement(
    { ...input, name: "", source: "compose", repo: null },
    teamId,
  );
  const deployable = (await listServersForTeam(teamId)).filter(
    canHostWorkloads,
  );
  const server =
    (input.serverId && deployable.find((s) => s.id === input.serverId)) ||
    deployable[0];
  // No server: createApp has its own sentence for that, and nothing to clash with.
  if (!server) return [];
  const taken = await namesOnNetwork(
    { teamId, environmentId: placement.environmentId, serverId: server.id },
    "",
  );
  const mine = [
    ...new Set(composeNamesOnNetwork(compose).map((n) => n.toLowerCase())),
  ].filter((n) => taken.has(n));
  if (mine.length === 0) return [];
  const { renames } = renameClashingServices(
    compose,
    new Set(mine),
    null,
    new Set(taken.keys()),
  );
  return mine.map((name) => ({
    name,
    owner: taken.get(name)!,
    renamedTo: renames.get(name) ?? name,
  }));
}

/**
 * A Docker-image app has no repository to read a port out of, and 3000 is a guess
 * that answers 502 on most images (`nginx`, `traefik/whoami`, `httpd` all listen
 * on 80). Ask the registry what the image itself declares, and only when the
 * caller did not say. Null - several ports, none, or a registry that would not
 * answer - keeps the default, which the Port field is there to correct.
 */
async function withImagePort(
  input: Pick<CreateAppInput, "source" | "dockerImage" | "build">,
): Promise<Partial<BuildConfig> | undefined> {
  const image = input.dockerImage?.trim();
  if (input.source !== "docker-image" || !image) return input.build;
  if (input.build?.port) return input.build;
  const port = await imageExposedPort(image).catch(() => null);
  return port ? { ...input.build, port } : input.build;
}

export async function createApp(input: CreateAppInput): Promise<AppSummary> {
  // `create_apps` is asked of the DESTINATION (resolvePlacement): a node grant can
  // hold it where the role does not, and withhold it where the role has it.
  const { membership, userId } = await requireMembership();
  input = { ...input, name: cleanAppName(input.name) };
  // A prebuilt image ref is interpolated raw into the compose `image:` scalar, so
  // reject anything that isn't a plain reference before it can inject service keys.
  if (
    input.source === "docker-image" &&
    input.dockerImage &&
    !IMAGE_REF_RE.test(input.dockerImage)
  )
    throw new Error(
      "Enter a valid image reference (e.g. nginx:1.27 or ghcr.io/org/app@sha256:…).",
    );
  // Linking a team's shared variables is an env act, and it is asked for BEFORE
  // anything is written: refusing after the insert would leave the app created
  // and the mutation failed.
  if (input.sharedVarIds?.length) await requireCapability("manage_env");
  // Binding a HOST port - a service's `ports:` - needs the expose-ports grant.
  // Two things that look like it are intentionally NOT gated: a public Traefik
  // DOMAIN (composeService/composePort/exposes), which is routing, and `expose:`,
  // which advertises a container port to the same network and binds nothing.
  if (input.compose != null && composePublishesPorts(input.compose)) {
    await requireExposePorts();
  }
  // A host bind mount baked into the initial compose needs the host-volume grant.
  // So does anything else that takes a service out of its sandbox (`privileged`,
  // `cap_add`, `devices`, `pid: host`, …): they reach the host WITHOUT naming a
  // path, so the bind-mount check alone let the same grant be walked around.
  if (input.compose != null) assertComposeWithinLimits(input.compose);
  const reach = input.compose != null ? composeHostReach(input.compose) : [];
  if (reach.length > 0) await requireMountHostVolumes(reach.join(", "));
  // A service that would claim one of Deplo's own DNS names on the shared
  // network. Refused early so the editor says it, rather than at deploy time
  // where `buildComposeStack` makes the same check against the final wiring.
  if (input.compose != null) {
    // Keys that merge config from a file Deplo can't inspect (`extends: {file}`,
    // top-level `include:`, `label_file:`) are refused outright: they smuggle host
    // access, ports, or another team's `traefik.*` labels past every check here.
    const merge = composeUsesExternalMerge(input.compose);
    if (merge) throw new Error(externalMergeMessage(merge));
    const claimed = composeClaimsReservedName(input.compose);
    if (claimed) throw new Error(reservedNameMessage(claimed));
    const filled = composeInterpolatedHostname(input.compose);
    if (filled) throw new Error(interpolatedHostnameMessage(filled));
  }
  // A REAL hostname is a domain claim, not a by-product of creating an app:
  // `domains.name` is instance-unique, which is why `addDomain` asks for
  // `manage_domains`. Our own nip.io hosts are no claim and stay ungated.
  const claimsAHostname = [
    input.autoDomain,
    ...(input.extraDomains ?? []).map((e) => e.host),
  ].some(isHostnameClaim);
  if (claimsAHostname) await requireCapability("manage_domains");
  // Where the app is filed (folder / project environment / top level) - resolved
  // and authorized BEFORE anything is written, so an unusable destination fails
  // the create outright instead of silently stranding the app at the top level.
  const placement = await resolveNewAppPlacement(input, membership.teamId);
  const user = (await getCurrentUser())!;
  const slugBase = input.name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // slug is globally UNIQUE in the relational table; pick the first free suffix
  // optimistically. The pick races a concurrent same-name create (both read the
  // same snapshot, pick the same suffix), so the INSERT is retried below on a
  // `apps_slug_uq` violation, advancing the suffix each time. `nextSlug`
  // continues the suffix sequence past whatever the pre-check already considered.
  const existing = new Set(
    (await getDb().select({ slug: appsTable.slug }).from(appsTable)).map(
      (r) => r.slug,
    ),
  );
  // A slug whose stack is still awaiting teardown on a host stays taken: the new
  // app (of any team) would otherwise adopt the old one's volumes and files.
  for (const p of await getDb()
    .select({ deployKey: pendingTeardownsTable.deployKey })
    .from(pendingTeardownsTable))
    existing.add(appSlugFromDeployKey(p.deployKey));
  const slugRoot = slugBase || `project-${newId("").slice(1, 6)}`;
  // `deplo-<slug>` is the container name and the name it answers to on the network
  // (ADR-0029), so a slug minting one of the platform's own is taken like any other:
  // an app called "Traefik" keeps its name and takes `traefik-1`, instead of failing
  // the deploy with a container-name conflict nobody outside Docker can read.
  const taken = (s: string): boolean =>
    existing.has(s) || isReservedSharedName(stackName(s));
  let i = 1;
  let slug = slugRoot;
  while (taken(slug)) slug = `${slugRoot}-${i++}`;
  const nextSlug = (): string => {
    let s = `${slugRoot}-${i++}`;
    while (taken(s)) s = `${slugRoot}-${i++}`;
    return s;
  };

  // Servers are relational (cut-set (e)); read the picklist for the `server_id`
  // FK from the `servers` table - scoped to the team, so a project can only land
  // on a server this team may target (every `all_teams` server + its grants).
  const servers = await listServersForTeam(membership.teamId);
  // An explicit pick must be one this team can actually use, otherwise a crafted
  // request could place a project on a server scoped to another team. Reject it
  // rather than silently falling back to a different server.
  if (input.serverId && !servers.some((s) => s.id === input.serverId))
    throw new Error("That server isn't available to this team.");
  // Default to the team's first server; honour an explicit pick. A specialised
  // host cannot run an app (storage-only has no Docker, build-only no proxy) -
  // the pickers hide them, but an id can also arrive from a bearer token.
  const deployable = servers.filter(canHostWorkloads);
  if (input.serverId && !deployable.some((s) => s.id === input.serverId))
    throw new Error("That server doesn't run apps.");
  const server =
    (input.serverId && deployable.find((s) => s.id === input.serverId)) ||
    deployable[0];
  if (!server)
    throw new Error(
      "No server available - add a server from Settings, Servers and run its install command first.",
    );
  // Where it COMPILES, on the same terms `setAppBuildServer` applies later: it has
  // to be a host this team can reach, a storage-only box has no Docker to build
  // with, and a migration source HAS Docker but is another platform's machine.
  // Validated here rather than trusted, because an import sends these ids from a
  // browser and a build carries the app's source and decrypted env.
  let buildServerId: string | null = null;
  if (input.buildServerId) {
    const picked = servers.find((b) => b.id === input.buildServerId);
    if (!picked)
      throw new Error("That build server isn't available to this team.");
    if (picked.storageOnly)
      throw new Error(
        "That server holds backups only - it has no Docker to build with.",
      );
    if (picked.importOnly) throw new Error(ON_IMPORT_SOURCE);
    buildServerId = picked.id;
  }

  // Same allow-list `setAppComposeUpArgs` enforces, and stored the same way -
  // the tokens as the deploy edge will send them.
  const rawComposeArgs = input.composeUpArgs?.trim() || null;
  if (rawComposeArgs) {
    const problem = validateComposeUpArgs(rawComposeArgs);
    if (problem) throw new Error(problem);
  }

  // A template's nip.io hosts are baked in /new against the instance IP, before
  // the server is known, so re-host them onto the target server's IP. A no-op
  // when the IP already matches and for hosts that are not nip.io.
  const serverIp = resolveServerIp(server);
  const hosts = rehostBlueprintHosts(
    {
      autoDomain: input.autoDomain,
      extraDomains: input.extraDomains,
      env: input.env,
    },
    instanceHost(),
    serverIp,
  );
  input.autoDomain = hosts.autoDomain;
  input.extraDomains = hosts.extraDomains;
  input.env = hosts.env;

  // A stack Deplo generated is renamed around a taken name rather than refused,
  // and everything that named the service (route, domains, env, files) follows.
  // ponytail: renamed before the lock, like the import; a concurrent clashing
  // create in the gap falls back to the refusal below, never to a collision.
  const renameNotes: string[] = [];
  if (input.renameClashes && input.compose) {
    const mine = new Set(
      composeNamesOnNetwork(input.compose).map((n) => n.toLowerCase()),
    );
    const taken = await namesTakenOnNetwork({
      teamId: membership.teamId,
      environmentId: placement.environmentId,
      serverId: server.id,
    });
    const renamed = renameClashingServices(
      input.compose,
      new Set([...taken].filter((n) => mine.has(n))),
      null,
      taken,
    );
    if (renamed.renames.size > 0) {
      const moved = (svc: string): string =>
        renamed.renames.get(svc.toLowerCase()) ?? svc;
      input.compose = renamed.compose;
      if (input.composeService)
        input.composeService = moved(input.composeService);
      input.extraDomains = input.extraDomains?.map((d) => ({
        ...d,
        service: moved(d.service),
      }));
      if (input.env) renameHostTokens(input.env, renamed.renames);
      // Same conservative match as env (`://db`, `@db`), so a config file's
      // `proxy_pass http://db/` follows the service it named.
      input.mounts = input.mounts?.map((m) => {
        const e = { key: "", value: m.content };
        renameHostTokens([e], renamed.renames);
        return { ...m, content: e.value };
      });
      renameNotes.push(...renamed.changes);
    }
  }

  if (input.mounts)
    input.mounts = input.mounts.map((m) => {
      if (Buffer.byteLength(m.content ?? "", "utf8") > MAX_MOUNT_BYTES)
        throw new Error(
          `${m.filePath} is too large for a config file (1 MiB max)`,
        );
      return { ...m, filePath: cleanMountPath(m.filePath) };
    });

  // An "upload" project has no archive at creation (it is uploaded from the
  // Settings page afterward, which triggers its own deploy via the upload route).
  // Deploying now would fail with "Nothing to deploy", so it is born idle instead
  // of queued; everything else starts queued and deploys below.
  const isUpload = input.source === "upload";

  const logo = input.logo && isValidLogoValue(input.logo) ? input.logo : null;

  const project: App = {
    id: newId("prj"),
    name: input.name.trim(),
    slug,
    teamId: membership.teamId,
    // Born where the user created it: the folder / project environment they had
    // open on the Overview, or the top level when created from nowhere in
    // particular. Re-filing later still goes through the move actions.
    folderId: placement.folderId,
    projectId: placement.projectId,
    environmentId: placement.environmentId,
    serverId: server.id,
    // A new app's data is wherever the app puts it. Only a migration can start one
    // whose volumes were meant to arrive from somewhere else and did not.
    dataCopyError: "",
    // Only an import marks an app as still arriving.
    migrationRunId: null,
    // Born on Automatic unless a caller placed it deliberately: a new app uses a
    // build server if the fleet has one and says nothing about it otherwise.
    // Choosing a builder is an Advanced setting and the create flow does not ask;
    // a bulk import does, because it is placing the whole fleet at once.
    buildServerId,
    buildFallback: true,
    // Defaulted from a template's logo (a /templates path); ignore anything that
    // isn't a valid inline logo so a crafted create payload can't store a URL.
    logo,
    // Only a template's logo gets read for a plate; the user's own is drawn as it is.
    logoTone: input.logoFromTemplate ? await logoToneFromDataUri(logo) : null,
    // Recognised from the app's own source by its FIRST deploy (which starts
    // below for every source but "upload"), not guessed at creation: the repo
    // read belongs on the deploy path, where it already happens for the logo.
    framework: null,
    // Nothing to correct before anything has been detected.
    frameworkOverride: null,
    source: input.source,
    // Same guard as updateAppSource: a credential id from another team is
    // dropped rather than used to clone with.
    repo: await scopeRepoCredentials(input.repo, membership.teamId),
    dockerImage: input.dockerImage ?? null,
    upload: null,
    compose: input.compose ?? null,
    mounts: input.mounts?.length ? input.mounts : null,
    build: buildConfigFor(await withImagePort(input)),
    productionUrl: null,
    status: isUpload ? "idle" : "queued",
    previewEnabled: false,
    // Off, like previews: a cron job runs arbitrary commands in the container,
    // so it is asked for rather than inherited.
    cronEnabled: false,
    // Same reasoning: a shell inside the container is asked for, never inherited.
    consoleEnabled: false,
    autoDeploy: input.autoDeploy ?? true,
    // The deploy hook answers as soon as someone opens it (it mints its URL on
    // first read and is bearer-gated either way), nothing to configure at create.
    deployHookEnabled: true,
    // The bring-up command starts untouched unless the create explicitly set flags.
    composeUpArgs: rawComposeArgs
      ? parseComposeUpArgs(rawComposeArgs).join(" ")
      : null,
    // Rollbacks are on from the first deploy - being able to undo one is not
    // something anyone should have to find a setting for first.
    rollbackKeep: DEFAULT_ROLLBACK_KEEP,
    // New apps start uncapped; limits are set later from Settings → Resources.
    resources: null,
    healthCheck: null,
    latestDeploymentId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  // Initial environment variables (e.g. a template's defaults), encrypted at rest.
  const now = nowIso();
  const appEnvVars: EnvVar[] = (input.env ?? [])
    .filter((e) => e.key.trim())
    .map((e) => {
      const key = e.key.trim();
      // Same gate as upsertEnv: a key with a newline/quote/`:` would break out of
      // the string-templated `environment:` block in renderCompose.
      if (!ENV_KEY_RE.test(key))
        throw new Error(`Invalid variable name: ${key}`);
      return {
        id: newId("env"),
        appId: project.id,
        key,
        valueEnc: encryptSecret(e.value),
        targets: ["production", "preview"] as EnvTarget[],
        type: e.type ?? ("plain" as const),
        // A template's defaults are still an authored write by whoever created the app.
        createdByUserId: userId,
        updatedByUserId: userId,
        createdAt: now,
        updatedAt: now,
      } satisfies EnvVar;
    });

  // One transaction: the app + its FK-coupled children + initial env; the domain
  // and the deploy fire AFTER commit so a failed insert leaves no orphan. Name
  // clash and insert take ONE lock - the compose file has no unique constraint,
  // and the optimistic slug pick is retried on `apps_slug_uq`, the real arbiter.
  await withNetworkLock(
    { teamId: membership.teamId, environmentId: placement.environmentId },
    async () => {
      if (input.compose != null)
        await assertNoNameClash({
          to: {
            teamId: membership.teamId,
            environmentId: placement.environmentId,
            serverId: server.id,
          },
          claims: composeNamesOnNetwork(input.compose),
          exceptId: "",
          subject: "this app",
        });
      for (let attempt = 0; ; attempt++) {
        try {
          await getDb().transaction(async (tx) => {
            // Re-assert server access inside the tx (SHARE-locks the server row) so a
            // concurrent setServerTeams restrict can't land this project on a server
            // the team just lost access to. One side of the race loses cleanly.
            await assertServerAccessibleTx(tx, server.id, membership.teamId);
            // `created_by_user_id` is deliberately NOT on the App domain type: it is
            // authorship metadata read only by the delete-a-user flow, never by the
            // renderer or any capability check, so it rides along with the insert
            // instead of widening every App the app graph assembles.
            await tx.insert(appsTable).values({
              ...appToRow(project),
              createdByUserId: userId,
              // Same reasoning as `created_by_user_id`: read only by the deploy's
              // grant check, so it rides with the insert rather than widening App.
              hostReachBy: reach.length > 0 ? userId : null,
            });
            await tx
              .insert(appBuildTable)
              .values(buildToRow(project.id, project.build));
            await tx
              .insert(appBuildMethodSettingsTable)
              .values(
                methodSettingsToRow(project.id, project.build.methodSettings),
              );
            const mountRows = mountsToRows(project.id, project.mounts);
            if (mountRows.length > 0)
              await tx.insert(appMountsTable).values(mountRows);
            if (appEnvVars.length > 0) await insertEnvVars(tx, appEnvVars);
          });
          break;
        } catch (e) {
          if (attempt < 5 && isUniqueViolation(e, "apps_slug_uq")) {
            project.slug = slug = nextSlug();
            continue;
          }
          throw e;
        }
      }
    },
  );
  await recordActivity(
    "app",
    `Created app ${project.name}`,
    user.name,
    project.id,
  );
  for (const note of renameNotes)
    await recordActivity("app", note, user.name, project.id);
  // Register the push webhook on the provider so the very first push after an
  // import already deploys - the same thing importing from GitHub gives you.
  // Best-effort: never let a third party's HTTP failure undo a created app.
  await syncAppWebhook(project.repo).catch(() => {});

  // POST-COMMIT (PLAN cut-set (c) "post-commit deploy"): register the generated
  // nip.io domain so it shows up in the Domains section immediately and the
  // deploy routes to the same hostname a template baked into its env. This is
  // the ONLY place a project's auto domain is born - deploys no longer create
  // one, so once every domain is deleted none is ever resurrected.
  const ip = resolveServerIp(server);
  // The PRIMARY domain's default route: an explicit composeService/composePort,
  // else the stack's detected service, else build.port. The service the SOURCE
  // named wins even when it named no port, or an import routes at its database.
  const namedPort =
    input.composeService && input.compose
      ? composeServicePort(input.compose, input.composeService)
      : null;
  const detected =
    input.composeService && (input.composePort ?? namedPort)
      ? {
          service: input.composeService,
          port: (input.composePort ?? namedPort)!,
        }
      : input.compose
        ? detectDefaultApp(input.compose)
        : null;
  // No certificate is registered by default - auto domains are born plain-HTTP
  // (`none`). The one opt-in: a blueprint that itself expects HTTPS (it baked an
  // `https://<one of its own hosts>` URL into its env, compose text, or a config
  // file) would break over plain HTTP, so ALL its auto domains get letsencrypt.
  const certProvider = blueprintWantsTls(
    [input.autoDomain, ...(input.extraDomains ?? []).map((e) => e.host)],
    [
      input.compose,
      ...(input.env ?? []).map((e) => e.value),
      ...(input.mounts ?? []).map((m) => m.content),
    ],
  )
    ? "letsencrypt"
    : "none";
  if (!input.noAutoDomain)
    await ensureAutoDomain(project.id, {
      slug,
      ip,
      preferred: input.autoDomain ?? undefined,
      preferredPath: input.autoDomainPath ?? undefined,
      defaultPort: detected?.port ?? project.build.port,
      defaultApp: detected?.service ?? null,
      certProvider,
    });

  // Register every EXTRA hostname a multi-domain template declares - ONCE, here,
  // never on a deploy, so a deleted extra is not resurrected. An extra on the
  // primary's own host is kept: same path ⇒ its own host, else the same host.
  for (const ex of input.extraDomains ?? []) {
    await ensureExtraDomain(project.id, ex.host.trim(), {
      port: ex.port,
      service: ex.service,
      // A host-less entry gets a generated one; a path lets it share the
      // primary's host (a UI on `/`, its API on `/api`).
      pathPrefix: ex.path ?? undefined,
      // Passed so a globally-colliding template host regenerates a unique one.
      slug,
      ip,
      // Same TLS choice as the primary: a blueprint that expects HTTPS gets it
      // on every host it declares; anything else is born plain-HTTP.
      certProvider,
    });
  }

  // Link the shared variables the create asked for, through the same gated call
  // the Environment tab uses - and BEFORE the deploy below, or the first build
  // would run without them.
  for (const varId of input.sharedVarIds ?? []) {
    await setSharedVarAppLink(varId, project.id, true);
  }

  // Kick off the first build + deploy in the background. `create_apps` is NOT
  // `deploy_apps`: a role may add an app without shipping code onto the fleet, so
  // it is asked ON THE NEW APP. Without it the app is born idle.
  const wantsDeploy = input.deploy !== false;
  if (
    !isUpload &&
    wantsDeploy &&
    (await hasAppCapability(project.id, "deploy_apps"))
  ) {
    await startDeployment(project.id, {
      environment: "production",
      creator: user.name,
      commitMessage: "Initial deployment",
    });
  } else if (!isUpload) {
    await getDb()
      .update(appsTable)
      .set({ status: "idle", updatedAt: nowIso() })
      .where(eq(appsTable.id, project.id));
  }

  return summarizeOne((await loadAppGraph(project.id))!);
}

/**
 * A config file's path inside the app's Files dir: a leading `/` is folded (as
 * the agent folds it), `..` and control characters are refused, and so is the
 * stack's own env-file, which the deploy writes there.
 */
const MAX_MOUNT_BYTES = 1024 * 1024;

function cleanMountPath(raw: string): string {
  const rel = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "")
    .replace(/\/$/, "");
  if (!rel || rel === ".")
    throw new Error("Give each config file a path inside the app's files");
  if (rel.split("/").some((seg) => seg === ".."))
    throw new Error(
      `A config file path must stay inside the app's files: ${raw}`,
    );
  if (/[\u0000-\u001f:$]/.test(rel))
    throw new Error(`A config file path can't contain that character: ${raw}`);
  if (rel === ".env")
    throw new Error(
      "The .env file is written by Deplo from the app's variables - edit those in Settings → Environment.",
    );
  return rel;
}

export async function createAppFromTemplate(
  input: CreateAppFromTemplateInput,
): Promise<AppSummary> {
  const template = await getTemplateVariant(
    input.templateSlug,
    input.variantSlug?.trim() || DEFAULT_VARIANT_SLUG,
  );
  if (!template) throw new Error("That template or variant isn't available.");

  const autoDomain = productionDomain(template.slug, instanceHost());
  const blueprint = getTemplateBlueprint(template, { domain: autoDomain });
  const logo = await templateLogoDataUri(template.variant.logo);

  return createApp({
    name: input.name?.trim() || template.name,
    source: "compose",
    repo: null,
    logo,
    logoFromTemplate: true,
    compose: blueprint.compose,
    env: blueprint.env,
    autoDeploy: false,
    composeService: blueprint.expose?.service ?? null,
    composePort: blueprint.expose?.port ?? null,
    extraDomains: blueprint.exposes.slice(1).map((expose) => ({
      service: expose.service,
      port: expose.port,
      host: expose.host ?? "",
      path: expose.path ?? null,
    })),
    autoDomain,
    autoDomainPath: blueprint.expose?.path ?? null,
    mounts: blueprint.mounts,
    serverId: input.serverId,
    projectId: input.projectId ?? null,
    environmentId: input.environmentId ?? null,
    folderId: input.folderId ?? null,
    deploy: input.deploy ?? false,
    renameClashes: true,
  });
}

export async function updateAppBuild(
  id: string,
  build: Partial<BuildConfig>,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  // build.port is only WHICH container port Traefik routes to (routing), not a
  // published host port, so changing it isn't gated behind the expose-ports
  // grant - any member who can deploy may edit build settings.
  const user = (await getCurrentUser())!;
  // One tx (PLAN cut-set (c) Decision 15): the parent `app_build` columns
  // MERGE field-by-field, while a provided `methodSettings` object FULLY REPLACES
  // the 1-to-1 method-settings row.
  let portBefore: number | null = null;
  await getDb().transaction(async (tx) => {
    const existing = await loadAppGraph(id, tx);
    if (!existing || existing.teamId !== membership.teamId)
      throw new Error("App not found");
    portBefore = existing.build.port ?? null;
    const merged: BuildConfig = {
      ...existing.build,
      ...build,
      // methodSettings replaces wholesale when provided, else keep the existing.
      methodSettings: build.methodSettings ?? existing.build.methodSettings,
      // The pending cache clear is armed by clearAppBuildCache and consumed by
      // the next build, never by a build-settings save. Saving the form while a
      // clear is armed must not swallow it (nor could a caller arm one here).
      buildCacheClearPending: existing.build.buildCacheClearPending,
    };
    await tx
      .update(appsTable)
      .set({ updatedAt: nowIso() })
      .where(eq(appsTable.id, id));
    await tx
      .update(appBuildTable)
      .set(buildToRow(id, merged))
      .where(eq(appBuildTable.appId, id));
    if (build.methodSettings) {
      // Whole-row replace of the method settings.
      await tx
        .update(appBuildMethodSettingsTable)
        .set(methodSettingsToRow(id, merged.methodSettings))
        .where(eq(appBuildMethodSettingsTable.appId, id));
    }
  });
  // Domains ROUTING TO the old port follow the new one: an auto domain carries
  // the build port from creation, so changing it left a green deploy and a 502
  // whose cause was on another screen. A DIFFERENT port was meant that way.
  if (portBefore != null && build.port != null && build.port !== portBefore) {
    const moved = await getDb()
      .update(domainsTable)
      .set({ port: build.port })
      .where(and(eq(domainsTable.appId, id), eq(domainsTable.port, portBefore)))
      .returning({ id: domainsTable.id });
    if (moved.length > 0)
      await recordActivity(
        "app",
        `Moved ${moved.length === 1 ? "1 domain" : `${moved.length} domains`} to port ${build.port}`,
        user.name,
        id,
      );
  }
  await markPendingChanges([id]);
  await recordActivity("app", `Updated build settings`, user.name, id);
}

/**
 * Arm the one-shot flag the NEXT build consumes. Nothing is deleted here: the
 * BuildKit cache is the SERVER's and shared by every app on it, so an app can
 * only clear its own by refusing to read it once. Idempotent.
 */
export async function clearAppBuildCache(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await getDb()
    .update(appBuildTable)
    .set({ buildCacheClearPending: true })
    .where(eq(appBuildTable.appId, id));
  await getDb()
    .update(appsTable)
    .set({ updatedAt: nowIso() })
    .where(eq(appsTable.id, id));
  await recordActivity(
    "app",
    `Cleared the build cache for ${project.name}`,
    user.name,
    id,
  );
}

/**
 * Choose where this app COMPILES. Null is Automatic; `buildFallback` false fails
 * rather than moving the build. Validated against the team's reachable servers -
 * a build carries the source and the decrypted env. Deliberately not a trigger.
 */
export async function setAppBuildServer(
  id: string,
  input: { buildServerId: string | null; buildFallback?: boolean },
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");

  let buildServerId: string | null = null;
  if (input.buildServerId) {
    const servers = await listServersForTeam(membership.teamId);
    const picked = servers.find((s) => s.id === input.buildServerId);
    if (!picked) throw new Error("That server isn't available to this team.");
    if (picked.storageOnly)
      throw new Error(
        "That server holds backups only - it has no Docker to build with.",
      );
    if (picked.importOnly) throw new Error(ON_IMPORT_SOURCE);
    buildServerId = picked.id;
  }
  await getDb()
    .update(appsTable)
    .set({
      buildServerId,
      ...(input.buildFallback === undefined
        ? {}
        : { buildFallback: input.buildFallback }),
      updatedAt: nowIso(),
    })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));

  const where =
    buildServerId === null
      ? "automatically"
      : buildServerId === project.serverId
        ? "on its own server"
        : `on ${(await getServerById(buildServerId))?.name ?? buildServerId}`;
  await recordActivity(
    "app",
    `Set ${project.name} to build ${where}`,
    user.name,
    id,
  );
}

export interface UpdateSourceInput {
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  serverId?: string;
  /** Compose YAML to persist (source === "compose"). Kept when switching away. */
  compose?: string | null;
}

/**
 * Drop any repo credential that does not belong to this team: both arrive as a
 * plain id, so a crafted payload would clone a private repo with another team's
 * token. Dropping (not failing) leaves an anonymous clone. Runs outside any tx.
 */
async function scopeRepoCredentials(
  repo: GitRepo | null,
  teamId: string,
): Promise<GitRepo | null> {
  if (!repo) return null;
  const out: GitRepo = { ...repo };
  if (out.installationId) {
    const mine = await listGithubInstallations();
    if (!mine.some((i) => i.id === out.installationId))
      out.installationId = null;
  }
  if (
    out.connectionId &&
    !(await gitConnectionInTeam(out.connectionId, teamId))
  ) {
    out.connectionId = null;
  }
  // No credential means the agent clones the address exactly as typed.
  if (!out.installationId && !out.connectionId)
    await assertCloneTargetSafe(out.url, {
      allowPrivate: await isInstanceAdmin(),
    });
  return out;
}

export async function updateAppSource(
  id: string,
  input: UpdateSourceInput,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  // A prebuilt image ref is interpolated raw into the compose `image:` scalar, so
  // reject anything that isn't a plain reference before it can inject service keys.
  if (
    input.source === "docker-image" &&
    input.dockerImage &&
    !IMAGE_REF_RE.test(input.dockerImage)
  )
    throw new Error(
      "Enter a valid image reference (e.g. nginx:1.27 or ghcr.io/org/app@sha256:…).",
    );
  // Saving compose YAML that binds a HOST port (`ports:`) requires the
  // expose-ports grant. Routing (the Traefik domains) lives in the `domains`
  // table, not here, and `expose:` binds nothing - neither is gated.
  if (input.compose != null && composePublishesPorts(input.compose)) {
    await requireExposePorts();
  }
  // Saving compose YAML that bind-mounts a host path requires the host grant,
  // and so does asking for host privileges (`privileged`, `cap_add`, `devices`,
  // `pid: host`, …), which reach the host without naming a path at all.
  if (input.compose != null) assertComposeWithinLimits(input.compose);
  const editReach =
    input.compose != null ? composeHostReach(input.compose) : [];
  if (editReach.length > 0) await requireMountHostVolumes(editReach.join(", "));
  // A service that would claim one of Deplo's own DNS names on the shared
  // network. Refused early so the editor says it, rather than at deploy time
  // where `buildComposeStack` makes the same check against the final wiring.
  if (input.compose != null) {
    // Keys that merge config from a file Deplo can't inspect (`extends: {file}`,
    // top-level `include:`, `label_file:`) are refused outright: they smuggle host
    // access, ports, or another team's `traefik.*` labels past every check here.
    const merge = composeUsesExternalMerge(input.compose);
    if (merge) throw new Error(externalMergeMessage(merge));
    const claimed = composeClaimsReservedName(input.compose);
    if (claimed) throw new Error(reservedNameMessage(claimed));
    const filled = composeInterpolatedHostname(input.compose);
    if (filled) throw new Error(interpolatedHostnameMessage(filled));
  }
  const user = (await getCurrentUser())!;
  const repo = await scopeRepoCredentials(input.repo, membership.teamId);
  // Team-scoped picklist: a move can only target a server this team may use.
  // The project's current server is always in here (revoking a team's access is
  // blocked while it has workloads on the server), so the old-IP lookup is safe.
  const serversById = new Map(
    (await listServersForTeam(membership.teamId)).map(
      (s) => [s.id, s] as const,
    ),
  );
  // The app's own placement: it decides which network its names live on, and so
  // the lock key below. Read before the transaction, never inside one - this runs
  // on its own connection.
  const [current] = await getDb()
    .select({
      name: appsTable.name,
      serverId: appsTable.serverId,
      previewServerId: appsTable.previewServerId,
      environmentId: appsTable.environmentId,
      compose: appsTable.compose,
      slug: appsTable.slug,
      migrateFromServerId: appsTable.migrateFromServerId,
      dataCopyError: appsTable.dataCopyError,
    })
    .from(appsTable)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)))
    .limit(1);
  const moving = Boolean(
    current && input.serverId && input.serverId !== current.serverId,
  );
  if (current && moving) {
    // Data an import could not copy is not there to move: the app deploys again
    // only once that is resolved on its page (a move's own hold is retried by it).
    if (current.dataCopyError && !current.migrateFromServerId)
      throw new Error(
        `${current.name}'s data did not come across from its migration - copy it again, or choose "Deploy anyway" on its page, before moving it.`,
      );
    // A host port is a singleton on the machine, and the new machine has its own
    // claims. Same rows-only check `setAppPorts` makes, against the destination.
    if (input.source !== "compose") {
      const claimed = await getDb()
        .select({ published: appPortsTable.published })
        .from(appPortsTable)
        .where(eq(appPortsTable.appId, id));
      for (const { published } of claimed)
        if (await hostPortClaimed(input.serverId!, published, { appId: id }))
          throw new Error(
            `Port ${published} is already published on ${serversById.get(input.serverId!)?.name ?? "that server"}. Change it under Ports first, or pick another server.`,
          );
    }
  }
  // Pull request previews follow the app's server unless pinned elsewhere, and
  // their teardown resolves the host from the app row: once it names the new
  // machine, the stacks on the old one could never be reached again. Before the
  // transaction, like every call that runs on its own connection.
  if (current && moving && !current.previewServerId) {
    await stopPreviewsForServerChange(id, input.serverId!);
  }
  // Set inside the tx, consumed after commit: the move's deploy, and the host a
  // re-targeted or called-off move leaves a half-built stack on.
  const after: {
    moved: boolean;
    stray: App | null;
    strayServerId: string | null;
  } = { moved: false, stray: null, strayServerId: null };
  // The repo this app deployed from BEFORE this save, so its push webhook can be
  // withdrawn after the commit when the app stops pointing at it. Held in an
  // object because a bare `let` assigned inside the callback narrows to `null`.
  const before: { repo: GitRepo | null } = { repo: null };
  // Check the names and write under ONE lock, or two concurrent saves both read
  // the same name as free on that network and both take it - there is no unique
  // constraint underneath, the names live inside a compose file.
  await withNetworkLock(
    {
      teamId: membership.teamId,
      environmentId: current?.environmentId ?? null,
    },
    async () => {
      // Asked when the compose changes OR when the SERVER does: a Docker network
      // lives on one machine, so moving an untouched stack to another host is
      // exactly as able to land it beside a name that is already taken there.
      if (current && (input.compose != null || input.serverId != null)) {
        // The compose being saved, or the one already stored when only the server moves.
        const compose = input.compose ?? current.compose ?? "";
        await assertNoNameClash({
          to: {
            teamId: membership.teamId,
            environmentId: current.environmentId,
            serverId: input.serverId ?? current.serverId,
          },
          claims: compose.trim()
            ? composeNamesOnNetwork(compose)
            : [stackName(current.slug)],
          exceptId: id,
          subject: "this app",
        });
      }
      await getDb().transaction(async (tx) => {
        const p = await loadAppGraph(id, tx);
        if (!p || p.teamId !== membership.teamId)
          throw new Error("App not found");
        before.repo = p.repo;
        // Capture the OLD server IP before serverId is reassigned, so a move can
        // re-host the project's auto nip.io domains onto the new server's IP below.
        const oldIp = resolveServerIp(serversById.get(p.serverId));
        const oldServerId = p.serverId;
        let serverId = p.serverId;
        if (input.serverId) {
          const picked = serversById.get(input.serverId);
          if (!picked) throw new Error("Server not found");
          // A move has to answer the same question a creation does. It never did:
          // membership was the only check here, so any specialised host - including a
          // migration source, which is another platform's machine - could be named as
          // a destination through the API and the app would land somewhere that runs
          // nothing.
          if (!canHostWorkloads(picked))
            throw new Error(
              picked.importOnly
                ? ON_IMPORT_SOURCE
                : picked.storageOnly
                  ? "That server holds backups only - nothing is deployed there."
                  : "That server only builds images - nothing is deployed there.",
            );
          serverId = input.serverId;
        }
        const isMove = serverId !== oldServerId;
        // The marker names the host that still HOLDS the data; the deploy on the
        // new host copies from it (completePendingAppMigration). An edit that is
        // not a move leaves a pending one alone. A move while one is pending keeps
        // its source - the data never left it - and the host in between is a stray;
        // moving back onto the source calls the move off.
        const pending = p.migrateFromServerId ?? null;
        let migrateFromServerId = pending;
        if (isMove) {
          migrateFromServerId =
            serverId === pending ? null : (pending ?? oldServerId);
          if (pending) {
            after.stray = p;
            after.strayServerId = oldServerId;
          }
        }
        after.moved = isMove;

        // MOVING to another server: the auto nip.io domains encode the OLD IP as
        // their trailing hex label, so re-host them or Domains (and Traefik's
        // target) keep pointing at the old host. Only the hex label changes.
        const newIp = resolveServerIp(serversById.get(serverId));
        if (newIp !== oldIp) {
          const appDomains = await loadDomainsForApp(p.id, tx);
          for (const dom of appDomains) {
            if (dom.source === "auto" && nipEmbeddedIp(dom.name) === oldIp) {
              await tx
                .update(domainsTable)
                .set({ name: rehostNip(dom.name, newIp) })
                .where(eq(domainsTable.id, dom.id));
            }
          }
        }

        // "Build on this app's own server" is stored as that server's id, so a MOVE has
        // to carry it or the setting silently becomes "build on the machine I just left"
        // - which is a real build server relationship, just not the one anyone asked
        // for. A pin to some OTHER host is a deliberate choice about that host and
        // stays put.
        const buildServerId =
          isMove && p.buildServerId === oldServerId
            ? serverId
            : (p.buildServerId ?? null);

        await tx
          .update(appsTable)
          .set({
            serverId,
            buildServerId,
            migrateFromServerId,
            // A fresh attempt clears a held move's block; an import's is refused above.
            ...(isMove && pending ? { dataCopyError: "" } : {}),
            source: input.source,
            repoProvider: repo?.provider ?? null,
            repoUrl: repo?.url ?? null,
            repoRepo: repo?.repo ?? null,
            repoBranch: repo?.branch ?? null,
            repoInstallationId: repo?.installationId ?? null,
            repoConnectionId: repo?.connectionId ?? null,
            repoTriggerType: repo?.triggerType ?? null,
            repoWatchPaths: repo?.watchPaths?.length
              ? repo.watchPaths.join("\n")
              : null,
            repoSubmodules: repo?.submodules ?? false,
            dockerImage: input.dockerImage,
            // Persist compose edits when provided; never clear a stored stack on
            // switch so the user can flip back to Compose and recover it.
            ...(input.compose != null
              ? {
                  compose: input.compose,
                  // Re-authored, so the reach is this saver's from here on (and null
                  // again when the compose stops reaching anything).
                  hostReachBy: editReach.length > 0 ? user.id : null,
                }
              : {}),
            updatedAt: nowIso(),
          })
          .where(eq(appsTable.id, id));
      });
    },
  );
  await recordActivity("app", `Updated deploy source`, user.name, id);
  // Push webhooks, AFTER the commit: both calls talk to a third party over HTTP,
  // and holding the app's row lock across someone else's network is how a save
  // starts taking thirty seconds. Neither can fail the save - a token without the
  // webhook scope still stores a working repository, and the Deploy Source card
  // shows the address to paste instead.
  const movedOff =
    before.repo?.connectionId &&
    (before.repo.connectionId !== repo?.connectionId ||
      before.repo.repo !== repo?.repo);
  if (movedOff) await dropAppWebhook(before.repo).catch(() => {});
  await syncAppWebhook(repo).catch(() => {});
  // The half-built stack on the host a re-targeted move passed through. Durable:
  // an unreachable host lands in the retry queue.
  if (after.stray && after.strayServerId)
    await teardownOrQueue({
      serverId: after.strayServerId,
      deployKey: after.stray.slug,
      projectLabel: after.stray.id,
      label: after.stray.name,
      teamId: membership.teamId,
      reclaimVolumes: appOwnVolumeNames(after.stray),
    }).catch(() => {});
  // A MOVE takes effect on a deploy, so trigger one here (fire-and-forget). The
  // upload source is the exception: its own "Save & Deploy" consumes the same
  // migration marker, and auto-deploying here too would double-fire.
  if (after.moved && input.source !== "upload") {
    try {
      await startDeployment(id, {
        creator: user.name,
        commitMessage: "Move to a different server",
      });
    } catch (e) {
      // The move (serverId + migration marker) is already committed, but the deploy
      // that would relocate the container + migrate the data failed to start. The
      // state is RECOVERABLE - the marker persists, so a manual production deploy
      // will still complete the move + copy. Surface a legible error instead of a
      // raw failure so the operator knows to redeploy.
      throw new Error(
        `The move was saved, but starting the initial deploy on the new server ` +
          `failed (${e instanceof Error ? e.message : String(e)}). Trigger a ` +
          `production deploy to complete the move and migrate the data.`,
      );
    }
  }
}

// Container paths the runtime owns, the managed-volume name shape, and its length
// cap all live in `lib/apps/volume-model.ts` - the SAME constants the Storage
// editor lints against, so the form cannot accept a mount this writer will
// refuse. Only the messages differ (API errors here, typing help there).

/**
 * Validate + canonicalize an app's full volume set. The renderer trusts its
 * input, so every path, name and service rule lives here. A HOST source is
 * checked for shape only - the grant that authorizes one is the caller's.
 */
export function validateVolumes(
  raw: VolumeMount[],
  existingMounts: { filePath: string }[] | null | undefined,
  composeServices?: string[] | null,
  opts?: {
    /**
     * Imported entries were RUNNING over there: `/var/jenkins_home` is what the
     * image uses, and refusing it drops the app's data dir instead of protecting
     * it. So an import is refused AT a reserved path, never merely under it.
     */
    imported?: boolean;
  },
): VolumeMount[] | null {
  const seenPath = new Set<string>();
  const seenName = new Set<string>();
  const mountFilePaths = (existingMounts ?? []).map((m) => m.filePath);
  const out: VolumeMount[] = [];
  for (const v of raw) {
    // Compose stacks only: which service gets the mount. Blank ⇒ the stack's
    // default service, resolved at render time (so a compose edit that renames
    // the default service can't strand the volume).
    let service: string | null = null;
    if (composeServices) {
      const wanted = (v.service ?? "").trim();
      if (wanted && !composeServices.includes(wanted)) {
        throw new Error(
          `Compose service "${wanted}" is not in this app's compose file.`,
        );
      }
      service = wanted || null;
    }
    const mountPath = (v.mountPath ?? "").trim().replace(/\/+$/, "") || "/";
    // `$` too: every one of these paths is written into the stack file verbatim,
    // and compose substitutes `$VAR` from the env-file at `up` - so a path with one
    // in it never means what it says, and `.../${X}` climbs wherever the variable
    // points.
    if (!/^\/[^\s:$]*$/.test(mountPath) || mountPath.length < 2) {
      throw new Error(
        `Mount path must be an absolute path with no spaces, ":" or "$": "${v.mountPath}"`,
      );
    }
    if (mountPath.split("/").includes("..")) {
      throw new Error(`Mount path must not contain "..": "${v.mountPath}"`);
    }
    // Reserved for a Volume or a Bind (they replace a whole directory), reserved
    // only AS ITSELF for a File - one config file inside /etc or /usr is the
    // commonest mount there is. See `reservedMountPath`.
    if (reservedMountPath(mountPath, opts?.imported ? "app" : kindOf(v))) {
      throw new Error(`Mount path "${mountPath}" is reserved by the system.`);
    }
    // A volume conflicts with a template config file when their paths are equal,
    // when the volume is INSIDE a config file's dir, OR when the volume's dir
    // would SHADOW (contain) a config file - any of which breaks the bind-mount.
    if (
      mountFilePaths.some((raw) => {
        const f = raw.replace(/\/+$/, "");
        return (
          f === mountPath ||
          mountPath.startsWith(f + "/") ||
          f.startsWith(mountPath + "/")
        );
      })
    ) {
      throw new Error(
        `Mount path "${mountPath}" conflicts with a template config file.`,
      );
    }
    // Unique per (service, path): docker rejects two mounts at the same path in
    // ONE container, but two services of a stack each mounting their own `/data`
    // is normal. `service` is always null for a single-container app, so this is
    // the plain project-wide check there.
    const pathKey = `${service ?? ""}\u0000${mountPath}`;
    if (seenPath.has(pathKey)) {
      throw new Error(`Duplicate mount path: "${mountPath}"`);
    }
    seenPath.add(pathKey);

    const name = (
      (v.name ?? "").trim() || deriveVolumeName(mountPath)
    ).toLowerCase();

    if (v.type === "app") {
      // Bind a path INSIDE the app's files dir: the source stays relative so a
      // ".." cannot climb out (a rename would then repoint it). An optional
      // "./" is accepted, a leading "/" is not - that is a gated host path.
      const projectPath = (v.projectPath ?? "")
        .trim()
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, "");
      if (projectPath === "" || projectPath.startsWith("/")) {
        throw new Error(
          `The path in this app's Files must be relative, for example "config.toml": "${v.projectPath}"`,
        );
      }
      if (/[\s:$]/.test(projectPath)) {
        throw new Error(
          `The path in this app's Files cannot contain spaces, ":" or "$": "${v.projectPath}"`,
        );
      }
      if (projectPath.split("/").includes("..")) {
        throw new Error(
          `The path in this app's Files cannot contain "..": "${v.projectPath}"`,
        );
      }
      out.push({
        id: v.id || newId("vol"),
        type: "app",
        name,
        projectPath,
        ...(service ? { service } : {}),
        mountPath,
        readOnly: Boolean(v.readOnly),
      });
      continue;
    }

    if (v.type === "host") {
      // Host bind mount: validate the host SOURCE path the same way as the
      // target (absolute, no spaces/":"/".."), but it is NOT reserved-prefix
      // checked - the source is a deliberate host path. No top-level volumes
      // entry is emitted, so docker-name rules don't apply.
      const hostPath = (v.hostPath ?? "").trim().replace(/\/+$/, "");
      if (!/^\/[^\s:$]*$/.test(hostPath) || hostPath.length < 2) {
        throw new Error(
          `The path on the server must be absolute, with no spaces, ":" or "$": "${v.hostPath}"`,
        );
      }
      if (hostPath.split("/").includes("..")) {
        throw new Error(
          `The path on the server cannot contain "..": "${v.hostPath}"`,
        );
      }
      // Propagation rides into the compose mount line verbatim, so it is checked
      // against the closed set here too and not only at the API's enum: this
      // function is the boundary every writer goes through.
      const propagation = v.propagation;
      if (propagation && !MOUNT_PROPAGATIONS.includes(propagation)) {
        throw new Error(
          `Unknown mount propagation "${propagation}" - use ${MOUNT_PROPAGATIONS.join(" or ")}.`,
        );
      }
      out.push({
        id: v.id || newId("vol"),
        type: "host",
        name,
        hostPath,
        ...(service ? { service } : {}),
        mountPath,
        readOnly: Boolean(v.readOnly),
        ...(propagation ? { propagation } : {}),
      });
      continue;
    }

    if (!VOLUME_NAME_RE.test(name) || name.length > VOLUME_NAME_MAX) {
      throw new Error(
        `Volume name "${name}" must be lowercase letters, digits, "-"/"_" (max ${VOLUME_NAME_MAX}).`,
      );
    }
    if (seenName.has(name)) {
      throw new Error(`Duplicate volume name: "${name}"`);
    }
    seenName.add(name);

    out.push({
      id: v.id || newId("vol"),
      name,
      ...(service ? { service } : {}),
      mountPath,
      readOnly: Boolean(v.readOnly),
    });
  }
  return out.length ? out : null;
}

/**
 * The published-port rules, applied before anything is written. Pure, so the
 * settings form and the importer can both lean on the same refusals.
 */
export function validatePorts(raw: PublishedPort[]): PublishedPort[] {
  const seen = new Set<string>();
  const out: PublishedPort[] = [];
  for (const p of raw) {
    const published = Number(p.published);
    const target = Number(p.target);
    if (!isValidExposePort(published))
      throw new Error(
        `A published port must be between ${MIN_USER_PORT} and ${MAX_PORT}: ${p.published}`,
      );
    if (!Number.isInteger(target) || target < 1 || target > MAX_PORT)
      throw new Error(`That is not a port inside the container: ${p.target}`);
    const protocol = p.protocol === "udp" ? "udp" : "tcp";
    const key = `${published}/${protocol}`;
    if (seen.has(key))
      throw new Error(`This app publishes ${published} twice.`);
    seen.add(key);
    out.push({
      id: p.id?.trim() || newId("prt"),
      published,
      target,
      protocol,
    });
  }
  if (out.length > MAX_PUBLISHED_PORTS)
    throw new Error(`An app can publish at most ${MAX_PUBLISHED_PORTS} ports.`);
  return out;
}

/**
 * Replace an app's published host ports (full set) - for what the proxy cannot
 * route. Persists only; the ports take effect on the next deploy. A compose stack
 * is refused: the `ports:` its author wrote are the ones that bind.
 */
export async function setAppPorts(
  id: string,
  ports: PublishedPort[],
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  // A published port leaves the container reachable PAST the proxy, and past
  // every gate the proxy applies - the same reach a host mount has, behind its
  // own grant. Clearing them all needs nothing.
  if (ports.length > 0) await requireExposePorts();
  const user = (await getCurrentUser())!;
  const validated = validatePorts(ports);

  const [app] = await getDb()
    .select({ source: appsTable.source, serverId: appsTable.serverId })
    .from(appsTable)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));
  if (!app) throw new Error("App not found");
  if (app.source === "compose")
    throw new Error(
      "A compose stack publishes its ports in its own compose file.",
    );
  // A host port is a singleton on the machine, and the machine is shared: the
  // row that would collide can belong to another team.
  // ponytail: rows only, no agent probe - a port something OUTSIDE Deplo holds
  // surfaces as docker's own refusal on the deploy, like a compose stack's does.
  for (const p of validated)
    if (await hostPortClaimed(app.serverId, p.published, { appId: id }))
      throw new Error(
        `Port ${p.published} is already published on this server. Pick a different one.`,
      );

  await getDb().transaction(async (tx) => {
    await tx.delete(appPortsTable).where(eq(appPortsTable.appId, id));
    const rows = portsToRows(id, validated);
    if (rows.length > 0) await tx.insert(appPortsTable).values(rows);
    await tx
      .update(appsTable)
      .set({ pendingChangesAt: nowIso(), updatedAt: nowIso() })
      .where(eq(appsTable.id, id));
  });
  await recordActivity("app", "Updated published ports", user.name, id);
}

/**
 * Replace an app's volumes (full set), compose stacks included - hand-writing
 * `volumes:` is exactly the Docker knowledge Deplo exists not to demand. Each row
 * carries its service, validated against the compose. Takes effect next deploy.
 */
export async function setAppVolumes(
  id: string,
  volumes: VolumeMount[],
  opts?: {
    /** Entries carried over from another platform - see {@link validateVolumes}. */
    imported?: boolean;
  },
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  // A host bind mount escapes the per-project sandbox, so it needs the dedicated
  // grant on top of `deploy` (instance admins hold it implicitly).
  if (volumes.some((v) => v.type === "host")) {
    await requireMountHostVolumes();
  }
  const user = (await getCurrentUser())!;
  await getDb().transaction(async (tx) => {
    const p = await loadAppGraph(id, tx);
    if (!p || p.teamId !== membership.teamId) throw new Error("App not found");
    // Validate against the project's mounts (the conflict check) and, for a
    // compose stack, against the services its compose declares, then whole-set
    // replace the `app_volumes` ordered child rows.
    const composeServices = usesComposeStack(p)
      ? composeServiceNames(p.compose)
      : null;
    const validated = validateVolumes(volumes, p.mounts, composeServices, opts);
    await tx.delete(appVolumesTable).where(eq(appVolumesTable.appId, id));
    const rows = volumesToRows(id, validated);
    if (rows.length > 0) await tx.insert(appVolumesTable).values(rows);
    await tx
      .update(appsTable)
      .set({ updatedAt: nowIso() })
      .where(eq(appsTable.id, id));
  });
  await recordActivity("app", `Updated volumes`, user.name, id);
}

/**
 * A resource-limits patch from the API. Every field is INDEPENDENTLY optional;
 * `null` (or absent) ⇒ that dimension is left uncapped. The Resources settings
 * form sends the full set on each save, so in practice this is a whole-object
 * replace: a field the user cleared arrives as `null` and clears its column.
 */
export type ResourceLimitsInput = {
  [K in keyof ResourceLimits]?: ResourceLimits[K] | null;
};

// A limit is a guard rail, not a quota - bounds are deliberately generous. We
// reject only what Docker itself would refuse (or an obvious typo) and NEVER
// clamp silently: a settings form should save exactly what you typed, or tell
// you why it can't. Ceilings exist just to turn a fat-fingered "999999" GiB into
// a clear error instead of a broken `compose up` on the host.
const MEM_MB_MAX = 1_048_576; // 1 TiB, in MiB
const CPU_MILLI_MAX = 512_000; // 512 cores, in milli-CPUs
const PIDS_MAX = 4_194_304; // kernel pid_max ceiling
const CPU_SHARES_MIN = 2;
const CPU_SHARES_MAX = 262_144; // Docker's documented cpu-shares range

/** Validate one optional integer limit; null/absent passes through as "uncapped". */
function intLimit(
  v: number | null | undefined,
  label: string,
  min: number,
  max: number,
): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`${label} must be a whole number.`);
  }
  if (v < min) throw new Error(`${label} must be at least ${min}.`);
  if (v > max) throw new Error(`${label} must be at most ${max}.`);
  return v;
}

/** Validate an optional CPU-set list like "0", "0,2" or "0-3". */
function cleanCpuset(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (!s) return null;
  if (!/^\d+([-,]\d+)*$/.test(s)) {
    throw new Error(
      'CPU pinning must be a core list like "0", "0,2" or "0-3".',
    );
  }
  return s;
}

/**
 * Normalize + validate a {@link ResourceLimitsInput}. PURE (no DB, no auth) so it
 * unit-tests directly. Throws a user-facing Error on any value `compose up` would
 * reject; an all-null input validates to "no limits set".
 */
export function cleanResourceLimits(
  input: ResourceLimitsInput,
): ResourceLimits {
  const memoryMb = intLimit(input.memoryMb, "Memory limit", 6, MEM_MB_MAX);
  const memoryReservationMb = intLimit(
    input.memoryReservationMb,
    "Memory reservation",
    6,
    MEM_MB_MAX,
  );
  const swapMb = intLimit(input.swapMb, "Swap limit", 6, MEM_MB_MAX * 2);
  const cpuMilli = intLimit(input.cpuMilli, "CPU limit", 10, CPU_MILLI_MAX);
  const cpuShares = intLimit(
    input.cpuShares,
    "CPU shares",
    CPU_SHARES_MIN,
    CPU_SHARES_MAX,
  );
  const cpuset = cleanCpuset(input.cpuset);
  const pidsLimit = intLimit(input.pidsLimit, "Process limit", 1, PIDS_MAX);
  const shmSizeMb = intLimit(input.shmSizeMb, "Shared memory", 1, MEM_MB_MAX);
  const storageGb = intLimit(input.storageGb, "Disk limit", 1, 65_536);
  const nofile = intLimit(input.nofile, "Open-files limit", 1, 1_073_741_816);
  const nproc = intLimit(input.nproc, "Process (ulimit) limit", 1, PIDS_MAX);
  const oomScoreAdj = intLimit(
    input.oomScoreAdj,
    "OOM score adjust",
    -1000,
    1000,
  );

  // Cross-field coherence - Docker rejects these combinations outright, so we
  // catch them here with a plain-language reason rather than at `compose up`.
  if (
    memoryReservationMb != null &&
    memoryMb != null &&
    memoryReservationMb > memoryMb
  ) {
    throw new Error("Memory reservation can't exceed the memory limit.");
  }
  if (swapMb != null) {
    if (memoryMb == null) {
      throw new Error(
        "Set a memory limit before a swap limit - the swap value is the memory + swap total.",
      );
    }
    if (swapMb < memoryMb) {
      throw new Error(
        "Swap limit must be at least the memory limit (it's the combined memory + swap total).",
      );
    }
  }

  return {
    memoryMb,
    memoryReservationMb,
    swapMb,
    cpuMilli,
    cpuShares,
    cpuset,
    pidsLimit,
    shmSizeMb,
    storageGb,
    nofile,
    nproc,
    oomScoreAdj,
  };
}

/**
 * Save an app's per-app resource limits (Settings → Resources). Same
 * `deploy` + folder gate as every other app-settings write; the limits take
 * effect on the NEXT deploy (they are baked into the rendered compose, like
 * volumes). A cleared field writes NULL, i.e. "uncapped".
 */
export async function updateAppResources(
  id: string,
  input: ResourceLimitsInput,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const cleaned = cleanResourceLimits(input);
  // A NEGATIVE oom_score_adj is the structured twin of compose's
  // `oom_kill_disable`: it tells the kernel to spare THIS container and kill its
  // neighbours (other tenants, and the platform's own containers) when the host
  // runs out of memory. Same cross-tenant reach, so the same grant. A positive
  // value only volunteers this container first and stays free, as does every
  // other cap here (they bound this app, they don't reach past it).
  if (cleaned.oomScoreAdj != null && cleaned.oomScoreAdj < 0) {
    await requireMountHostVolumes();
  }
  await updateAppOwned(id, membership.teamId, {
    ...resourceLimitsToRow(cleaned),
    pendingChangesAt: nowIso(),
    updatedAt: nowIso(),
  });
  await recordActivity("app", "Updated resource limits", user.name, id);
}

/**
 * Save an app's health check (Settings → Advanced). Takes effect on the NEXT
 * deploy - the block is baked into the rendered compose. A compose stack is
 * refused: the `healthcheck:` its author wrote is the one that runs.
 */
export async function updateAppHealthCheck(
  id: string,
  input: HealthCheck | null,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const [app] = await getDb()
    .select({ source: appsTable.source })
    .from(appsTable)
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));
  if (!app) throw new Error("App not found");
  if (app.source === "compose")
    throw new Error(
      "A compose stack's health check belongs in its own compose file.",
    );
  const problem = healthCheckProblem(input);
  if (problem) throw new Error(problem);
  await updateAppOwned(id, membership.teamId, {
    ...healthCheckToRow(input),
    pendingChangesAt: nowIso(),
    updatedAt: nowIso(),
  });
  await recordActivity(
    "app",
    input ? "Turned on the health check" : "Turned off the health check",
    user.name,
    id,
  );
}

/**
 * Point a project at a freshly uploaded archive and switch its source to
 * "upload". Called by the upload route handler after the file is on disk; the
 * route then triggers a deploy that extracts and builds it. Forgets any repo /
 * docker image so the deploy pipeline takes the upload branch unambiguously.
 */
export async function setAppUpload(
  id: string,
  upload: UploadArchive,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "deploy_apps");
  const user = (await getCurrentUser())!;
  await updateAppOwned(id, membership.teamId, {
    source: "upload",
    uploadId: upload.id,
    uploadFilename: upload.filename,
    uploadPath: upload.path,
    uploadSize: upload.size,
    uploadUploadedAt: upload.uploadedAt,
    // Forget any repo / docker image so the deploy takes the upload branch.
    // Clear ALL nine flattened repo_* columns as one unit (matching appToRow
    // and updateAppSource) so no stale git deploy option is left orphaned on a
    // now-repoless app.
    repoProvider: null,
    repoUrl: null,
    repoRepo: null,
    repoBranch: null,
    repoInstallationId: null,
    repoConnectionId: null,
    repoTriggerType: null,
    repoWatchPaths: null,
    repoSubmodules: false,
    dockerImage: null,
    updatedAt: nowIso(),
  });
  await recordActivity("app", `Uploaded ${upload.filename}`, user.name, id);
}

export async function setAutoDeploy(id: string, value: boolean): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  await updateAppOwned(id, membership.teamId, {
    autoDeploy: value,
    updatedAt: nowIso(),
  });
}

export async function renameApp(id: string, name: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const clean = cleanAppName(name);
  await updateAppOwned(id, membership.teamId, {
    name: clean,
    updatedAt: nowIso(),
  });
  await recordActivity("app", `Renamed app to ${clean}`, user.name, id);
}

/**
 * Set (or clear) the app's display logo - stored INLINE as a data-URI or a local
 * /templates path, never a remote URL, so it renders under the strict CSP. No-op
 * when unchanged, so an idle Save does not reorder the dashboard.
 */
export async function updateAppLogo(
  id: string,
  logo: string | null,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const next = logo?.trim() ? logo.trim() : null;
  if (next && !isValidLogoValue(next)) {
    throw new Error("Unsupported logo image");
  }
  // No-op (no updatedAt bump, no activity) when unchanged: only update rows whose
  // logo actually differs (a team-scoped conditional UPDATE … RETURNING).
  const updated = await getDb()
    .update(appsTable)
    // The plate belongs to a template's logo. This one is the user's.
    .set({ logo: next, logoTone: null, updatedAt: nowIso() })
    .where(
      and(
        eq(appsTable.id, id),
        eq(appsTable.teamId, membership.teamId),
        next === null
          ? sql`${appsTable.logo} is not null`
          : sql`${appsTable.logo} is distinct from ${next}`,
      ),
    )
    .returning({ id: appsTable.id });
  // Distinguish "not found / not owned" from "unchanged": a found-but-unchanged
  // row simply skips the activity below. Verify existence only when nothing changed.
  if (updated.length === 0) {
    const exists = await appInTeam(id, membership.teamId);
    if (!exists) throw new Error("App not found");
    return;
  }
  await recordActivity("app", `Updated app logo`, user.name, id);
}

/**
 * Why detection came up empty, in the terms of where it actually looked. A
 * compose app is read twice - its own files AND the icon the running app serves,
 * so telling that user we found "no file named favicon" would describe half
 * the search and point them at the wrong thing to fix.
 */
function noIconFoundMessage(
  app: Parameters<typeof detectAppFavicon>[0],
): string {
  if (faviconSourceKind(app) === "app-files") {
    return "No icon found. Deplo looked in this app's files and asked the running app for its favicon - check that the app is running and serves one.";
  }
  return "No file named favicon (SVG, PNG or ICO) found in this app's files";
}

/**
 * Re-run favicon detection on demand and set what it finds as the logo,
 * overwriting the current value - the user explicitly asked to detect. The
 * automatic hooks still only ever fill a NULL logo.
 */
export async function redetectAppLogo(id: string): Promise<string> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId) {
    throw new Error("App not found");
  }
  // A compose stack is read on its own server - its files, and the icon the
  // running app serves, so its routed domains come along: they name the compose
  // service and port the app answers on, which is how the probe reaches it the
  // same way Traefik does.
  const domains = await loadDomainsForApp(id);
  const routes = domains.map((d) => ({
    name: d.name,
    service: d.service ?? null,
    port: d.port ?? null,
    pathPrefix: d.pathPrefix ?? "",
    stripPrefix: d.stripPrefix ?? false,
  }));
  const primaryHost =
    domains.find((d) => d.primary)?.name ?? domains[0]?.name ?? "";
  // "We couldn't reach the server" must not be reported as "your app has no icon".
  const logo = await detectAppFavicon(project, routes, primaryHost).catch(
    (e) => {
      if (e instanceof AgentUnreachableError) {
        throw new Error(
          "The server that runs this app didn't answer, so Deplo couldn't read its files. It may be offline.",
          { cause: e },
        );
      }
      throw e;
    },
  );
  if (!logo || !isValidLogoValue(logo)) {
    throw new Error(noIconFoundMessage(project));
  }
  await getDb()
    .update(appsTable)
    .set({ logo, logoTone: null, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));
  await recordActivity("app", `Detected app logo from source`, user.name, id);
  publishAppChanged(id);
  return logo;
}

/**
 * Read a repository the user is ABOUT to deploy, before any app row exists.
 * Gated on `deploy`, and a foreign installation id is DROPPED rather than used,
 * which degrades to the unauthenticated read a public repo wants.
 */
export async function previewRepoFramework(input: {
  repo: string;
  url?: string | null;
  branch?: string | null;
  installationId?: string | null;
  buildMethod: BuildMethod;
  rootDirectory?: string | null;
}): Promise<RepoBuildHints> {
  await requireCapability("create_apps");
  if (!supportsFrameworkDetection(input.buildMethod))
    return {
      framework: null,
      staticOutput: null,
      startCommand: null,
      buildCommand: null,
    };

  let installationId: string | null = null;
  if (input.installationId) {
    const installations = await listGithubInstallations();
    installationId =
      installations.find((i) => i.id === input.installationId)?.id ?? null;
  }

  return detectRepoFramework(
    {
      provider: "github",
      url: input.url?.trim() || `https://github.com/${input.repo.trim()}`,
      repo: input.repo.trim(),
      branch: input.branch?.trim() || "",
      installationId,
    },
    input.rootDirectory,
  );
}

/**
 * Correct the framework Deplo recognised, or drop the correction and go back to
 * detection. Its own column, never over `apps.framework`, which the deploy keeps
 * re-detecting into. An id the catalog does not know is refused, not stored.
 */
export async function setAppFramework(
  id: string,
  framework: string | null,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const value = framework?.trim() || null;
  if (value !== null && !isFrameworkId(value))
    throw new Error(`Unknown framework "${value}"`);
  const updated = await getDb()
    .update(appsTable)
    .set({ frameworkOverride: value, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
  await recordActivity(
    "app",
    value
      ? `Set framework to ${frameworkById(value)?.name ?? value}`
      : `Reset framework to what Deplo detects`,
    user.name,
    id,
  );
  publishAppChanged(id);
}

/**
 * Set (or clear) the extra flags this app adds to its `docker compose up`.
 * Validated here, not only in the form: the same value arrives from the bearer
 * API and would reach a host's argv. The agent vets it a second time.
 */
export async function setAppComposeUpArgs(
  id: string,
  value: string | null,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const raw = value?.trim() || null;
  if (raw) {
    const problem = validateComposeUpArgs(raw);
    if (problem) throw new Error(problem);
  }
  const updated = await getDb()
    .update(appsTable)
    // Store the tokens as the deploy edge will send them, so what the settings
    // page shows next is exactly what runs (no stray double spaces to puzzle over).
    .set({
      composeUpArgs: raw ? parseComposeUpArgs(raw).join(" ") : null,
      updatedAt: nowIso(),
    })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
  await recordActivity(
    "app",
    raw
      ? `Set extra compose flags to ${parseComposeUpArgs(raw).join(" ")}`
      : "Cleared the extra compose flags",
    user.name,
    id,
  );
  publishAppChanged(id);
}

/**
 * Set how many previous deployments this app can be rolled back to.
 * `configure_apps`, not `rollback_apps`: it is a RETENTION number, i.e. how much
 * disk the app holds. Takes effect on the sweep after the next deploy.
 */
export async function setAppRollbackKeep(
  id: string,
  count: number,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  // Clamp rather than reject: the field is a number input with the same bounds,
  // so anything outside them arrived from an API client, and the honest answer to
  // "keep 900 rollbacks" is the ceiling, not an error about a number nobody typed.
  const keep = Number.isFinite(count)
    ? Math.min(MAX_ROLLBACK_KEEP, Math.max(0, Math.trunc(count)))
    : DEFAULT_ROLLBACK_KEEP;
  const updated = await getDb()
    .update(appsTable)
    .set({ rollbackKeep: keep, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
  await recordActivity(
    "app",
    keep === 0 ? "Turned rollbacks off" : `Set rollbacks kept to ${keep}`,
    user.name,
    id,
  );
  publishAppChanged(id);
}

/**
 * Set an app's status and notify every live subscriber. NOT gated and NOT
 * team-scoped: every caller has already resolved the app through a capability
 * check, and the write is unconditional so it cannot lose a race with a deploy.
 */
export async function setAppStatus(
  id: string,
  status: AppStatus,
): Promise<void> {
  await getDb()
    .update(appsTable)
    .set({ status, updatedAt: nowIso() })
    .where(eq(appsTable.id, id));
  publishAppChanged(id);
}

/** Stop the project's running container. */
export async function stopApp(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "control_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  // Persist "stopping" BEFORE the (up to 60s) container stop so the transition
  // is visible to every client immediately and survives a reload, not just a
  // local label on the clicking user's button. We settle to "idle" once the
  // stop returns (success or failure: the intent was to stop).
  await setAppStatus(id, "stopping");
  await recordActivity("app", `Stopping ${project.name}`, user.name, id);
  try {
    await stopContainer(project.slug);
  } catch (e) {
    // A stop failure must FAIL CLEARLY (PLAN Part C): the container may still be
    // running on the host, so settling to "idle" would lie. This covers BOTH an
    // unreachable agent (AgentUnreachableError) AND a reachable agent that
    // reported the stop failed (build.ts throws a plain Error on ok:false).
    await setAppStatus(id, "active");
    throw new Error(
      `The stack on ${project.name}'s server was not stopped: ${errMsg(e)}`,
    );
  }
  await setAppStatus(id, "idle");
}

/** Start a previously stopped project's container. */
export async function startApp(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "control_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  // Start is a second door onto the same volumes, and it skips the deploy
  // pipeline entirely - so it needs the same refusal.
  assertDataCopyIntact(project.name, project.dataCopyError);
  // `compose start` starts the container it FINDS, on the network it was created
  // with, so a stack stopped before a move would come back on the old one - and if
  // that network has since been reclaimed, not come back at all. Re-render first:
  // `up -d` brings the stack up on the right network in one step, and only when
  // there was nothing to change does the plain start do the work.
  await setAppStatus(id, "active");
  try {
    if ((await rerouteApp(id)) !== "rerouted")
      await startContainer(project.slug);
  } catch (e) {
    // Start failure (unreachable, or agent reported start failed): fail clearly
    // rather than leaving it "active" falsely.
    await setAppStatus(id, "idle");
    throw new Error(
      `The stack on ${project.name}'s server was not started: ${errMsg(e)}`,
    );
  }
  await recordActivity("app", `Started ${project.name}`, user.name, id);
}

/** What the button rebuilds: only a source Deplo builds gets a new image. */
const REBUILD_MESSAGE: Record<DeploySource, string> = {
  github: "Rebuild container",
  git: "Rebuild container",
  upload: "Rebuild container",
  "docker-image": "Pull and recreate the container",
  compose: "Recreate the stack's containers",
};

/**
 * Rebuild the image and FORCE the container to be recreated: `compose up -d`
 * compares its own config hash and would otherwise finish green with the same
 * container running - the one case this button exists for.
 */
export async function rebuildApp(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "deploy_apps");
  const user = (await getCurrentUser())!;
  const source = await appSourceInTeam(id, membership.teamId);
  if (!source) throw new Error("App not found");
  await startDeployment(id, {
    environment: "production",
    creator: user.name,
    commitMessage: REBUILD_MESSAGE[source],
    forceRecreate: true,
  });
}

/**
 * Stamp `deleting_at` - the point of no return, written before a byte is torn
 * down. From here every gate refuses the app and its pages 404, so a reload
 * cannot serve back a live-looking app. Nothing ever clears it.
 */
async function markAppsDeleting(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .update(appsTable)
    .set({ deletingAt: nowIso() })
    .where(inArray(appsTable.id, ids));
}

/**
 * Gate the delete, load what the teardown needs, and mark the app. Split from
 * the teardown so BOTH shapes of delete share one gate and one stamp: the
 * awaited {@link deleteApp} and the fire-and-forget {@link startAppDelete} the
 * UI uses.
 */
async function beginAppDelete(
  id: string,
): Promise<{ project: App; actor: string }> {
  const { membership } = await requireAppCapability(id, "delete_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await markAppsDeleting([id]);
  return { project, actor: user.name };
}

/**
 * Every volume Deplo itself created for this app, by its name ON THE HOST - a
 * Storage volume (`deplo-<slug>-<alias>`) or one from the user's compose
 * (`deplo-<slug>_<alias>`). A host bind or a foreign volume is not Deplo's.
 */
/**
 * Delete an app and WAIT for its host to be clear of it. The identity-free half
 * of the delete (`actor` is already resolved), so the boot reconcile can finish
 * a delete whose control plane died without a session to read.
 */
async function destroyApp(project: App, actor: string): Promise<void> {
  const id = project.id;
  // Tear down before dropping the records, OUTSIDE any tx and under the app's
  // lifecycle lock so a deploy mid-build cannot resurrect the stack. An
  // unreachable host does not block the delete: the teardown queue retries it.
  const tornDown = await withKeyedLock(`app-lifecycle:${id}`, async () => {
    // Pull request previews FIRST: the DELETE below cascades their rows away,
    // and with them the only record that those containers and volumes exist.
    await destroyPreviewsForApp(id).catch(() => {});
    // `removeVolumes` - deleting an app takes its data with it. Keeping them
    // meant an invisible, unreclaimable pile nothing could list; the safety net
    // for a delete you regret is the BACKUP. An `external:` volume survives.
    const ok = await teardownOrQueue({
      serverId: project.serverId,
      deployKey: project.slug,
      projectLabel: project.id,
      label: project.name,
      teamId: project.teamId,
      // Named BY NAME, because `down -v` can only reclaim what the compose file
      // ON THE HOST declares, and an app that was never deployed has no file
      // there. That is exactly the state a migrated app sits in between "the
      // data arrived" and "somebody deployed it", so deleting one used to leave
      // its imported volumes on the disk with nothing able to name them.
      reclaimVolumes: appOwnVolumeNames(project),
    });
    // Mid-move, the data (and a running stack) is still on the host it is
    // leaving; the row about to go is the only thing that names that host.
    if (project.migrateFromServerId)
      await teardownOrQueue({
        serverId: project.migrateFromServerId,
        deployKey: project.slug,
        projectLabel: project.id,
        label: project.name,
        teamId: project.teamId,
        reclaimVolumes: appOwnVolumeNames(project),
      }).catch(() => {});
    // Drop any uploaded archive backing an "upload" source.
    await removeUploads(id).catch(() => {});
    // One DELETE - the FK CASCADEs do the rest: deployments (+ logs), env_vars
    // (+ targets), domains (+ middlewares), the 6 project child tables, the
    // team_app_order rows, AND shared_env_var_apps (the per-app shared-variable
    // links, the orphan the old JSONB deleteApp leaked is now impossible, PLAN §7
    // "the live cascade is fixed in cut-set (c)"). backups.project_id is SET NULL (history outlives the
    // project), so no project-target backup is orphaned either.
    await getDb().delete(appsTable).where(eq(appsTable.id, id));
    return ok;
  });
  const server = await getServerById(project.serverId);
  if (!tornDown) {
    await recordActivity(
      "app",
      `Deleted ${project.name}, but ${server?.name ?? "its server"} did not answer. ` +
        `Deplo will retry the teardown until it succeeds.`,
      actor,
      null,
      project.teamId,
    );
  }
  await recordActivity(
    "app",
    `Deleted project ${project.name}`,
    actor,
    null,
    project.teamId,
  );
}

/**
 * Delete an app, waiting for the host to be clear of it - the whole operation in
 * one await, for a caller that has no response to get out of the way of (a
 * script, a test asserting the cascade). Anything serving a user wants
 * {@link startAppDelete} instead.
 */
export async function deleteApp(id: string): Promise<void> {
  const { project, actor } = await beginAppDelete(id);
  await destroyApp(project, actor);
}

/**
 * The same delete, minus the wait - what the dashboard calls. The app is stamped
 * (and locked everywhere) before this returns; the teardown finishes behind the
 * response, and its failure goes to the teardown queue, not to the caller.
 */
export async function startAppDelete(id: string): Promise<void> {
  const { project, actor } = await beginAppDelete(id);
  void destroyApp(project, actor).catch((e) =>
    console.error(
      `[deplo] delete of ${project.name} did not finish:`,
      errMsg(e),
    ),
  );
}

/**
 * Bulk-delete several apps: bounded-concurrency teardowns, then ALL their records
 * in a SINGLE write - one persist and one activity row instead of N round-trips.
 * Team-scoped; foreign ids are ignored. Returns how many were deleted.
 */
export async function deleteApps(ids: string[]): Promise<number> {
  const { apps, actor } = await beginAppsDelete(ids);
  if (apps.length === 0) return 0;
  await destroyApps(apps, actor);
  return apps.length;
}

/**
 * The bulk delete the dashboard calls - the multi-select twin of
 * {@link startAppDelete}. Every selected app is stamped (and so locked, and so
 * pulsing on the Overview) before this returns; the teardowns run behind the
 * response, where a slow host can't hold up a selection of twenty.
 */
export async function startAppsDelete(ids: string[]): Promise<number> {
  const { apps, actor } = await beginAppsDelete(ids);
  if (apps.length === 0) return 0;
  void destroyApps(apps, actor).catch((e) =>
    console.error("[deplo] bulk delete did not finish:", errMsg(e)),
  );
  return apps.length;
}

/** Gate each app on its own node, then stamp them all. See {@link beginAppDelete}. */
async function beginAppsDelete(
  ids: string[],
): Promise<{ apps: App[]; actor: string }> {
  const { membership } = await requireMembership();
  const user = (await getCurrentUser())!;
  const idSet = [...new Set(ids)];
  // Team- and scope-scoped: only the caller's own apps, fully loaded for teardown.
  // An app already being deleted is dropped like an unknown id rather than
  // refused: it is on its way out either way, and one already-doomed card in a
  // multi-select must not fail the delete of the other nineteen.
  const apps = (await loadAppsByIds(idSet)).filter(
    (p) => p.teamId === membership.teamId && inAppScope(p) && !p.deletingAt,
  );
  if (apps.length === 0) return { apps, actor: user.name };

  // Gate EACH app on its own node: bulk delete is not a way around per-folder
  // access, and since ADR-0016 `delete_apps` can be held on one app alone, so
  // the question has to be asked per app rather than once for the team.
  for (const p of apps) {
    await requireAppCapability(p.id, "delete_apps");
  }
  await markAppsDeleting(apps.map((p) => p.id));
  return { apps, actor: user.name };
}

/** The identity-free teardown half of {@link deleteApps}. */
async function destroyApps(apps: App[], actor: string): Promise<void> {
  const serversById = new Map(
    (await listAllServers()).map((s) => [s.id, s] as const),
  );
  // Tear down ≤4 at a time (agent calls OUTSIDE any tx); one failure must not
  // abort the others. Each runs under its own app's lifecycle lock, so a
  // concurrent deploy cannot orphan a stack. FK CASCADEs remove the children.
  const unreachable: string[] = [];
  await mapLimit(apps, 4, async (project) => {
    const tornDown = await withKeyedLock(
      `app-lifecycle:${project.id}`,
      async () => {
        // Preview stacks first - see deleteApp.
        await destroyPreviewsForApp(project.id).catch(() => {});
        // Volumes go too - see deleteApp for why "keeping" them was not a kindness.
        const ok = await teardownOrQueue({
          serverId: project.serverId,
          deployKey: project.slug,
          projectLabel: project.id,
          label: project.name,
          teamId: project.teamId,
          reclaimVolumes: appOwnVolumeNames(project),
        }).catch(() => false);
        await removeUploads(project.id).catch(() => {});
        await getDb().delete(appsTable).where(eq(appsTable.id, project.id));
        return ok;
      },
    );
    if (!tornDown) {
      const server = serversById.get(project.serverId);
      unreachable.push(`${project.name} (${server?.name ?? "its server"})`);
    }
  });

  await recordActivity(
    "app",
    `Deleted ${apps.length} project${apps.length === 1 ? "" : "s"}`,
    actor,
    null,
    apps[0]!.teamId,
  );
  if (unreachable.length) {
    await recordActivity(
      "app",
      `Some servers did not answer during the delete. Deplo will retry the ` +
        `teardown of: ${unreachable.join(", ")}.`,
      actor,
      null,
      apps[0]!.teamId,
    );
  }
}

/**
 * Finish the deletes a dead control plane left stamped: the teardown runs behind
 * the response, so a restart in the middle of one would leave the app stamped
 * forever. Identity-free (the actor is "Deplo") - there is no session at boot.
 */
export async function resumeAppDeletes(): Promise<void> {
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(isNotNull(appsTable.deletingAt));
  for (const { id } of rows) {
    const project = await loadAppGraph(id);
    if (!project) continue;
    await destroyApp(project, "Deplo").catch((e) =>
      console.error(
        `[deplo] could not finish deleting ${project.name}:`,
        errMsg(e),
      ),
    );
  }
}

/** Which container a whole-contents action runs over - a folder or a project. */
export type AppScope = { folderId?: string | null; projectId?: string | null };

/**
 * Every app in a folder's WHOLE subtree, or in a project (every environment plus
 * a legacy folder filed under it) - the same two sources the tile counts.
 * Team-scoped rows only: the caller applies its own reach.
 */
async function appsInScope(
  teamId: string,
  scope: AppScope,
): Promise<
  {
    id: string;
    folderId: string | null;
    projectId: string | null;
    environmentId: string | null;
  }[]
> {
  if (!scope.folderId && !scope.projectId)
    throw new Error("Pick a folder or a project to act on");
  const tree = await getDb()
    .select({
      id: foldersTable.id,
      parentId: foldersTable.parentId,
      projectId: foldersTable.projectId,
    })
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId));
  const folderIds = scope.folderId
    ? [...descendantFolderIds(scope.folderId, tree)]
    : // A project's apps are its own (ADR-0009's per-environment membership),
      // plus anything inside a LEGACY folder filed under it - the same two
      // sources its tile counts.
      tree
        .filter((f) => f.projectId === scope.projectId)
        .flatMap((f) => [...descendantFolderIds(f.id, tree)]);
  return getDb()
    .select({
      id: appsTable.id,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(
      and(
        eq(appsTable.teamId, teamId),
        scope.folderId
          ? inArray(appsTable.folderId, folderIds)
          : folderIds.length > 0
            ? or(
                eq(appsTable.projectId, scope.projectId!),
                inArray(appsTable.folderId, folderIds),
              )
            : eq(appsTable.projectId, scope.projectId!),
      ),
    );
}

/**
 * Stop and delete every app in a folder or project - run BEFORE the container
 * itself goes (ADR-0016). Gated per app on `delete_apps`, so one refusal fails
 * the whole thing rather than leaving half a folder destroyed.
 */
export async function deleteAppsIn(scope: AppScope): Promise<number> {
  const { membership } = await requireMembership();
  const rows = await appsInScope(membership.teamId, scope);
  if (rows.length === 0) return 0;
  return startAppsDelete(rows.map((r) => r.id));
}

/** The lifecycle actions a folder or a project runs over all of its apps at once. */
export type BulkAppAction = "start" | "stop" | "restart" | "redeploy";

/**
 * Run ONE lifecycle action on every app in a folder or project. It only fans out
 * to the same per-app function the single-app menu calls, so the gates and the
 * trail are identical. Unreachable apps are skipped, refusals counted, 4 at a time.
 */
export async function bulkAppAction(
  action: BulkAppAction,
  scope: AppScope,
): Promise<{ ok: number; failed: number; error: string | null }> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;

  const rows = await appsInScope(teamId, scope);
  // Token scope first, then per-app reach: the same two filters `listApps`
  // applies, so a bulk action can never touch an app its own list wouldn't show.
  const scoped = rows.filter((p) => inAppScope(p));
  const reach = await appCapabilitiesForTeam(
    teamId,
    scoped.map((p) => ({
      id: p.id,
      folderId: p.folderId ?? null,
      projectId: p.projectId ?? null,
      environmentId: p.environmentId ?? null,
    })),
  );
  const targets = scoped
    .filter((p) => (reach.get(p.id)?.length ?? 0) > 0)
    .map((p) => p.id);

  let ok = 0;
  let failed = 0;
  let error: string | null = null;
  await mapLimit(targets, 4, async (id) => {
    try {
      if (action === "redeploy") await redeploy(id);
      else {
        // start / stop / restart in one pair of steps: a restart is both.
        if (action !== "start") await stopApp(id);
        if (action !== "stop") await startApp(id);
      }
      ok++;
    } catch (e) {
      failed++;
      error ??= errMsg(e);
    }
  });
  return { ok, failed, error };
}
