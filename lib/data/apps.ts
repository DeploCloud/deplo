import "server-only";

import { cache } from "react";
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
  appBuild as appBuildTable,
  appBuildMethodSettings as appBuildMethodSettingsTable,
  appMounts as appMountsTable,
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
  composeHasHostBindMount,
  composeNeedsHostPrivileges,
  composePublishesPorts,
} from "../deploy/compose-lint";
import { composeServiceNames } from "../deploy/compose-stack";
import {
  parseComposeUpArgs,
  validateComposeUpArgs,
} from "../deploy/compose-args";
import {
  RESERVED_MOUNT_PREFIXES,
  VOLUME_NAME_MAX,
  VOLUME_NAME_RE,
} from "../apps/volume-model";
import {
  DEFAULT_ROLLBACK_KEEP,
  MAX_ROLLBACK_KEEP,
  MOUNT_PROPAGATIONS,
} from "../types";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import { matchesQuery } from "./match-query";
import { buildConfigFor } from "../frameworks";
import type {
  BuildConfig,
  BuildMethod,
  Capability,
  Deployment,
  DeploySource,
  EnvTarget,
  EnvVar,
  GitRepo,
  App,
  AppStatus,
  ResourceLimits,
  UploadArchive,
  VolumeMount,
} from "../types";
import { mapLimit, usesComposeStack } from "../utils";
import {
  startDeployment,
  stopContainer,
  startContainer,
} from "../deploy/build";
import { ensureAutoDomain, ensureExtraDomain } from "./domains";
import { requireFolderCapability } from "./folder-access";
import { defaultEnvironmentFor } from "./projects";
import {
  resolveServerIp,
  instanceHost,
  rehostNip,
  rehostBlueprintHosts,
  nipEmbeddedIp,
  blueprintWantsTls,
} from "../deploy/domains";
import { teardownApp, redeploy } from "./deployments";
import { descendantFolderIds } from "./folders";
import { destroyPreviewsForApp } from "../deploy/preview-lifecycle";
import { withKeyedLock } from "./keyed-mutex";
import { removeUploads } from "../deploy/upload";
import { isValidLogoValue } from "../apps/logo-shared";
import { detectAppFavicon } from "../apps/favicon-detect";
import { faviconSourceKind } from "../apps/favicon-shared";
import { detectRepoFramework } from "../apps/framework-source";
import {
  frameworkById,
  isFrameworkId,
  supportsFrameworkDetection,
  type FrameworkId,
} from "../apps/framework-catalog";
import { listGithubInstallations } from "./github";
import {
  dropAppWebhook,
  gitConnectionInTeam,
  syncAppWebhook,
} from "./git-connections";
import { AgentUnreachableError, BACKUP_RUN_MAX_MS } from "../infra/agent-client";
import { publishAppChanged } from "../graphql/pubsub";
import {
  inAppScope,
  inFolderScope,
  inProjectScope,
  narrowedScope,
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
  type SummaryPreload,
} from "./app-graph-load";
import {
  buildToRow,
  methodSettingsToRow,
  mountsToRows,
  appToRow,
  resourceLimitsToRow,
  volumesToRows,
} from "./app-graph-rows";
import { detectDefaultApp } from "../deploy/compose-stack";
import {
  appCapabilities,
  appCapabilitiesForTeam,
  hasAppCapability,
  nodeCapabilitiesFor,
  requireAppCapability,
} from "./node-access";

/** Heuristic: treat secret-looking keys as masked secrets. */
function isSecretKey(key: string): boolean {
  return /pass|secret|token|key|api|private|credential|dsn|url/i.test(key);
}

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
      return o.constraint === constraint || (o.message?.includes(constraint) ?? false);
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

// The pure read-time normalizers moved to `./normalize-app` so the
// app-graph backfill can apply the IDENTICAL normalization before exploding a
// legacy row into the strict child tables (relational-store PLAN §7). The live
// READ path no longer normalizes (relational rows are already in the current
// model — the backfill/live writes store normalized rows). `deriveVolumeName` is
// still used by `validateVolumes` here and re-exported for the volume tests.
import { deriveVolumeName } from "./normalize-app";

export { deriveVolumeName };

/**
 * "stopping" is a transient state held only while `stopApp` awaits the
 * container teardown (≤60s). If the server is killed mid-stop, a project can be
 * left wedged in "stopping" forever. Self-heal on read: a "stopping" project
 * whose last update is older than the stop timeout is reported as "idle" (the
 * stop's intended terminal state). The store row is not rewritten here — the
 * next real status change persists the corrected value.
 */
const STOPPING_STALE_MS = 90_000;

/**
 * "restoring" is the same shape of promise over a much longer call: the restore
 * runs inside one HTTP request, holds no lock, and has no crash recovery, so a
 * control plane that dies mid-restore would pin the app in "restoring" forever.
 * The window is the agent's own ceiling for a backup operation — anything longer
 * than that is not a slow restore, it is a restore nobody is running any more —
 * and it heals to "error", not "idle": a half-restored app is broken, not stopped
 * on purpose, and the telemetry reconciler promotes it back to "active" on its own
 * the moment the host says the containers are up.
 */
const RESTORING_STALE_MS = BACKUP_RUN_MAX_MS;

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
  if (status === "stopping") return age > STOPPING_STALE_MS ? "idle" : "stopping";
  if (status === "restoring")
    return age > RESTORING_STALE_MS ? "error" : "restoring";
  return status;
}

/**
 * Fold a (relational, already-normalized) project into a {@link AppSummary}
 * — a PURE function over preloaded latest-deployment + domain-count maps (PLAN §6
 * "`summarize` becomes a pure function over preloaded data"). No DB access, so a
 * list of N apps costs the bounded batch-load below, not N×(deployment +
 * domain) round-trips. `reconcileStatus` still self-heals a wedged "stopping".
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
      ? pre.latestDeployments.get(p.latestDeploymentId) ?? null
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
 *
 * `query` filters by name, slug or id - the same match `search` uses across
 * teams, so "find it here" and "find it anywhere" never disagree about what
 * counts as a hit. Filtering here rather than in SQL keeps the scope and folder
 * gates below untouched: an app the caller may not list stays unlistable
 * whatever they type.
 */
export async function listApps(query?: string): Promise<AppSummary[]> {
  const teamId = await requireActiveTeamId();
  const [all, rank] = await Promise.all([
    loadAppsByTeam(teamId),
    appOrderRank(teamId),
  ]);
  // `loadAppsByTeam` is an engine primitive (the deploy queue and team teardown
  // read through it too) and must never filter itself — the project scope of an
  // API token is applied HERE, where the answer is a user-facing list.
  // A stamped app (`deleting_at`) is GONE as far as the product is concerned —
  // every gate refuses it and its pages 404 — so it is not listed either. It
  // used to be, dimmed and pulsing until the teardown finished, but nothing
  // refreshes the Overview when the host is done: the card sat there pulsing
  // for good, and the next delete was the only thing that ever cleared it.
  const scoped = all.filter((p) => inAppScope(p) && !p.deletingAt);
  // …and so is per-app access: an app the caller holds nothing on (one inside a
  // folder they can't see) is not theirs to list. One batched resolution for the
  // whole team, not one per app.
  //
  // A narrowed token is NOT exempt. It used to be, because the token clamp
  // strips `manage_team` and so blinded a super-user's scoped token to every
  // folder — that is fixed at the source (`holdsManageTeam` reads the person),
  // and the exemption it justified was how a token scoped to a folder its
  // creator cannot see listed the apps inside.
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
 * Persist the team-wide order of apps shown in the Overview grid. Team-wide
 * by design — every member sees the same arrangement — so it is gated like a
 * team setting: an instance admin (who bypasses team capabilities) or a member
 * holding `manage_team`. The incoming ids are sanitised to the caller's own team
 * apps (dropping unknown/duplicate ids); the `team_app_order` junction is
 * rewritten over the survivors. Any team project the client omitted is appended,
 * so the stored order stays total — and a dead id can no longer be stored at all
 * (the FK CASCADE makes the self-healing a DB invariant, PLAN §1).
 */
export async function reorderApps(orderedIds: string[]): Promise<void> {
  const teamId = await requireActiveTeamId();
  // A team-wide arrangement is not something a project-scoped token rewrites —
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
      await tx.insert(teamAppOrder).values(
        next.map((appId, position) => ({ teamId, appId, position })),
      );
    }
  });
}

/** Summarize a single already-loaded project (its own bounded preload). */
async function summarizeOne(p: App): Promise<AppSummary> {
  const pre = await preloadSummaries([p]);
  return summarize(p, pre);
}

// React-cached so a request that reads the same project twice — e.g. the project
// layout's generateMetadata AND its render — only hits the DB once per request.
export const getAppBySlug = cache(async function getAppBySlug(
  slug: string
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
 * Whether the caller holds ANYTHING on this app. `view` is implied for anyone
 * with any access, so an empty set means they can't reach a single section of it
 * - and a page they may not read one field of is a page they may not open.
 * Every app page loads through the two functions above, so this one guard is
 * what keeps an app in a folder they can't see out of the whole UI.
 */
async function canReachApp(id: string): Promise<boolean> {
  return (await appCapabilities(id)).length > 0;
}

/**
 * The cookie-free twin of {@link canReachApp}, for the subscription seams.
 *
 * `appCapabilities` resolves the caller through `getCurrentUser()`, which reads
 * cookies — not callable across the async-iteration ticks of a long-lived SSE
 * response. So the principal is passed in and the per-app answer comes from
 * `nodeCapabilitiesFor`, which takes an explicit user id and touches nothing
 * request-scoped beyond the token identity (safe: yoga re-establishes it around
 * every tick).
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
 * App summary by id for an already-resolved team and principal, WITHOUT reading
 * the request's cookies. The live `appStatus` subscription resolves the caller
 * once from the GraphQL context (`ctx.teamId` / `ctx.viewer`, established in
 * request scope) and then reloads snapshots through this seam on each change —
 * Next's `cookies()` is NOT callable across the async-iteration ticks of a
 * long-lived SSE response (it runs after the request scope closes), so both are
 * passed explicitly rather than re-derived. The same applies to the slug lookup
 * below. Stays cookie-free: it queries Postgres with the passed ids directly and
 * never calls `requireActiveTeamId()` / a cookie-reading helper (PLAN §6 "SSE
 * generators must stay cookie-free").
 *
 * `inAppScope` is safe here for the same reason: it reads the request identity,
 * which the yoga subscribe hook re-establishes around every iterator tick, and
 * never touches cookies or a request-scoped cache.
 *
 * The per-app reachability check is the same one `getAppBySlug` applies: an app
 * whose folder the caller can't see is not theirs to watch either. Without it a
 * live status feed — name, source repo, URL, every deployment — was readable for
 * an app they are refused everywhere else, which made the subscription the one
 * way around folder privacy.
 */
export async function summarizeForTeam(
  id: string,
  teamId: string,
  userId: string,
): Promise<AppSummary | null> {
  const p = await loadAppGraph(id);
  return p && p.teamId === teamId && inAppScope(p) && (await reachableByUser(userId, teamId, p.id))
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
  return p && p.teamId === teamId && inAppScope(p) && (await reachableByUser(userId, teamId, p.id))
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
  compose?: string | null;
  env?: { key: string; value: string }[];
  serverId?: string;
  build?: Partial<BuildConfig>;
  autoDeploy?: boolean;
  /** Compose/template deploys: which service + port the PRIMARY domain routes
   * to. When absent for a compose project, detectDefaultApp picks one. */
  composeService?: string | null;
  composePort?: number | null;
  /** A multi-domain template's EXTRA (non-primary) routed hosts — each becomes
   * its own auto Domain row at creation (the primary is the `autoDomain`). The
   * `domains` table is the sole routing source afterward; there is no `exposes`. */
  extraDomains?: { service: string; port: number; host: string }[] | null;
  /** Pre-generated PRIMARY domain a template baked into its env; kept consistent. */
  autoDomain?: string | null;
  /** Template config files to materialise at deploy time. */
  mounts?: { filePath: string; content: string }[] | null;
  /** WHERE the app is born. The Overview drill-ins (an open folder, or a
   *  project's selected environment) thread their context through `/new`, so an
   *  app created while standing inside a folder lands IN that folder instead of
   *  at the team top level. Omitted ⇒ top level. See {@link resolveNewAppPlacement}. */
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}

/**
 * Resolve (and authorize) where a brand-new app is filed.
 *
 * ADR-0009: an app lives in exactly ONE place — a folder, or one environment of
 * a project, or the top level. The folder and project drill-ins are mutually
 * exclusive on the Overview, so if both somehow arrive the folder wins.
 *
 * Authorized exactly like a MOVE into the same destination (`moveAppToFolder` /
 * `moveAppToEnvironment`): the destination must belong to the active team, and
 * filing into a folder additionally needs `deploy` ON THAT FOLDER — otherwise
 * the create path would be a way to smuggle an app into a folder the caller
 * doesn't control. Errors mirror the move path's ("Folder not found") so a
 * foreign id never leaks existence.
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
  // A caller who reaches part of the team creates INSIDE that part or not at
  // all — otherwise the create path is how anyone walks out of their own
  // boundary. Which question to ask depends on where the app is being filed: an
  // app lives in exactly ONE place, and a FOLDER has no `project_id` of its own,
  // so asking about the project for a folder destination answered "no project ⇒
  // out of scope" and refused a folder-scoped caller their own folder. The team
  // top level (neither set) is outside every narrowed scope, which is the
  // fail-closed default. Same messages the destination lookups use, so nothing
  // leaks — and both principals are asked, a token through the request predicate
  // and a member through their role's reach.
  const roleScope = await currentMemberScope();
  if (placement.folderId) {
    if (!inFolderScope(placement.folderId) || !folderInScope(roleScope, placement.folderId))
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
          and(eq(foldersTable.id, input.folderId), eq(foldersTable.teamId, teamId)),
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
        .innerJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id))
        .where(eq(environmentsTable.id, input.environmentId))
        .limit(1)
    )[0];
    if (!env || env.teamId !== teamId) throw new Error("Environment not found");
    // An explicitly passed project must agree with the environment it names —
    // a mismatched pair is a bug (or a crafted payload), never a placement.
    if (input.projectId && input.projectId !== env.projectId)
      throw new Error("Environment not found");
    return { folderId: null, projectId: env.projectId, environmentId: env.id };
  }
  if (input.projectId) {
    const p = (
      await getDb()
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(
          and(eq(projectsTable.id, input.projectId), eq(projectsTable.teamId, teamId)),
        )
        .limit(1)
    )[0];
    if (!p) throw new Error("Project not found");
    // No environment named: land in the project's default one, same as a move.
    const env = await defaultEnvironmentFor(p.id);
    return { folderId: null, projectId: p.id, environmentId: env?.id ?? null };
  }
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

export async function createApp(
  input: CreateAppInput
): Promise<AppSummary> {
  const { membership, userId } = await requireCapability("create_apps");
  input = { ...input, name: cleanAppName(input.name) };
  // A prebuilt image ref is interpolated raw into the compose `image:` scalar, so
  // reject anything that isn't a plain reference before it can inject service keys.
  if (input.source === "docker-image" && input.dockerImage && !IMAGE_REF_RE.test(input.dockerImage))
    throw new Error("Enter a valid image reference (e.g. nginx:1.27 or ghcr.io/org/app@sha256:…).");
  // Publishing container ports — a service's `ports:` (bound to the host) or
  // `expose:` (advertised to linked containers) — needs the expose-ports grant.
  // Giving a service a public Traefik DOMAIN (composeService/composePort/exposes)
  // is routing, NOT port publishing, so it is intentionally NOT gated here.
  if (input.compose != null && composePublishesPorts(input.compose)) {
    await requireExposePorts();
  }
  // A host bind mount baked into the initial compose needs the host-volume grant.
  // So does anything else that takes a service out of its sandbox (`privileged`,
  // `cap_add`, `devices`, `pid: host`, …): they reach the host WITHOUT naming a
  // path, so the bind-mount check alone let the same grant be walked around.
  if (
    input.compose != null &&
    (composeHasHostBindMount(input.compose) ||
      composeNeedsHostPrivileges(input.compose))
  ) {
    await requireMountHostVolumes();
  }
  // Where the app is filed (folder / project environment / top level) — resolved
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
  // same snapshot, pick the same suffix) — so the INSERT is retried below on a
  // `apps_slug_uq` violation, advancing the suffix each time. `nextSlug`
  // continues the suffix sequence past whatever the pre-check already considered.
  const existing = new Set(
    (await getDb().select({ slug: appsTable.slug }).from(appsTable)).map(
      (r) => r.slug,
    ),
  );
  const slugRoot = slugBase || `project-${newId("").slice(1, 6)}`;
  let i = 1;
  let slug = slugRoot;
  while (existing.has(slug)) slug = `${slugRoot}-${i++}`;
  const nextSlug = (): string => {
    let s = `${slugRoot}-${i++}`;
    while (existing.has(s)) s = `${slugRoot}-${i++}`;
    return s;
  };

  // Servers are relational (cut-set (e)); read the picklist for the `server_id`
  // FK from the `servers` table — scoped to the team, so a project can only land
  // on a server this team may target (every `all_teams` server + its grants).
  const servers = await listServersForTeam(membership.teamId);
  // An explicit pick must be one this team can actually use — otherwise a crafted
  // request could place a project on a server scoped to another team. Reject it
  // rather than silently falling back to a different server.
  if (input.serverId && !servers.some((s) => s.id === input.serverId))
    throw new Error("That server isn't available to this team.");
  // Default to the first server available to the team; honour the explicit pick.
  // With no accessible server, surface a clear error so the operator adds (and
  // provisions) a host — or grants this team access — first.
  // A specialised host cannot run an app: a storage-only one has no Docker, a
  // build-only one has no proxy and exists to compile for other machines. The
  // pickers already hide them, but this is the boundary - an id can also arrive
  // from a bearer token, and the failure would otherwise land on the host.
  const deployable = servers.filter(canHostWorkloads);
  if (input.serverId && !deployable.some((s) => s.id === input.serverId))
    throw new Error("That server doesn't run apps.");
  const server =
    (input.serverId && deployable.find((s) => s.id === input.serverId)) ||
    deployable[0];
  if (!server)
    throw new Error(
      "No server available — add a server from Settings → Servers and run its install command first.",
    );

  // A template's generated nip.io hosts (the primary autoDomain + every
  // exposes[].host, and any env value that embedded ${domain}) are baked in the
  // /new page against the instance IP (instanceHost), because the server isn't
  // known until submit. If this project targets a DIFFERENT server, those hosts
  // would route to (and display) the wrong IP — re-host them onto the target
  // server's IP. A no-op when the target IP matches and for non-nip.io hosts.
  // resolveServerIp falls back to instanceHost for a server with no known IP yet,
  // so that case also no-ops rather than rehosting toward a bad address.
  const serverIp = resolveServerIp(server);
  const hosts = rehostBlueprintHosts(
    { autoDomain: input.autoDomain, extraDomains: input.extraDomains, env: input.env },
    instanceHost(),
    serverIp,
  );
  input.autoDomain = hosts.autoDomain;
  input.extraDomains = hosts.extraDomains;
  input.env = hosts.env;

  // An "upload" project has no archive at creation (it is uploaded from the
  // Settings page afterward, which triggers its own deploy via the upload route).
  // Deploying now would fail with "Nothing to deploy", so it is born idle instead
  // of queued; everything else starts queued and deploys below.
  const isUpload = input.source === "upload";

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
    // Born on Automatic: a new app uses a build server if the fleet has one and
    // says nothing about it otherwise. Choosing a builder is an Advanced setting,
    // and the create flow deliberately does not ask.
    buildServerId: null,
    buildFallbackLocal: true,
    // Defaulted from a template's logo (a /templates path); ignore anything that
    // isn't a valid inline logo so a crafted create payload can't store a URL.
    logo: input.logo && isValidLogoValue(input.logo) ? input.logo : null,
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
    build: buildConfigFor(input.build),
    productionUrl: null,
    status: isUpload ? "idle" : "queued",
    previewEnabled: false,
    // Off, like previews: a cron job runs arbitrary commands in the container,
    // so it is asked for rather than inherited.
    cronEnabled: false,
    autoDeploy: input.autoDeploy ?? true,
    // The deploy hook answers as soon as someone opens it (it mints its URL on
    // first read and is bearer-gated either way) — nothing to configure at create.
    deployHookEnabled: true,
    // The bring-up command starts untouched; extra flags are an advanced setting.
    composeUpArgs: null,
    // Rollbacks are on from the first deploy - being able to undo one is not
    // something anyone should have to find a setting for first.
    rollbackKeep: DEFAULT_ROLLBACK_KEEP,
    // New apps start uncapped; limits are set later from Settings → Resources.
    resources: null,
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
      if (!ENV_KEY_RE.test(key)) throw new Error(`Invalid variable name: ${key}`);
      return {
      id: newId("env"),
      appId: project.id,
      key,
      valueEnc: encryptSecret(e.value),
      targets: ["production", "preview"] as EnvTarget[],
      type: isSecretKey(e.key) ? ("secret" as const) : ("plain" as const),
      // A template's defaults are still an authored write by whoever created the app.
      createdByUserId: userId,
      updatedByUserId: userId,
      createdAt: now,
      updatedAt: now,
      } satisfies EnvVar;
    });

  // One transaction: the project + its FK-coupled children (build,
  // method-settings, exposes, mounts) + initial env (PLAN cut-set (c) Decision 15).
  // The domain + deploy fire AFTER commit so a failed insert leaves no orphan
  // auto-domain and no deploy job for a project that didn't persist.
  //
  // The optimistic slug pick races a concurrent same-name create, so the whole tx
  // is retried (bounded) on a `apps_slug_uq` violation, advancing to the next
  // free suffix — the `UNIQUE(slug)` constraint is the real arbiter, the in-app
  // pick is just a friendly first guess.
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
        await tx
          .insert(appsTable)
          .values({ ...appToRow(project), createdByUserId: userId });
        await tx.insert(appBuildTable).values(buildToRow(project.id, project.build));
        await tx
          .insert(appBuildMethodSettingsTable)
          .values(methodSettingsToRow(project.id, project.build.methodSettings));
        const mountRows = mountsToRows(project.id, project.mounts);
        if (mountRows.length > 0) await tx.insert(appMountsTable).values(mountRows);
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
  await recordActivity("app", `Created project ${project.name}`, user.name, project.id);
  // Register the push webhook on the provider so the very first push after an
  // import already deploys - the same thing importing from GitHub gives you.
  // Best-effort: never let a third party's HTTP failure undo a created app.
  await syncAppWebhook(project.repo).catch(() => {});

  // POST-COMMIT (PLAN cut-set (c) "post-commit deploy"): register the generated
  // nip.io domain so it shows up in the Domains section immediately and the
  // deploy routes to the same hostname a template baked into its env. This is
  // the ONLY place a project's auto domain is born — deploys no longer create
  // one, so once every domain is deleted none is ever resurrected.
  const ip = resolveServerIp(server);
  // The PRIMARY domain's default route: an explicit composeService/composePort
  // (the wizard's single picker), else — for a compose project — the service
  // detectDefaultApp picks from the stack, else build.port (single-image,
  // appless). After creation the `domains` table (each row's service) is the
  // sole routing source.
  const detected =
    input.composeService && input.composePort
      ? { service: input.composeService, port: input.composePort }
      : input.compose
        ? detectDefaultApp(input.compose)
        : null;
  // No certificate is registered by default — auto domains are born plain-HTTP
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
  const primaryName = await ensureAutoDomain(project.id, {
    slug,
    ip,
    preferred: input.autoDomain ?? undefined,
    defaultPort: detected?.port ?? project.build.port,
    defaultApp: detected?.service ?? null,
    certProvider,
  });

  // Register every EXTRA hostname a multi-domain template declares (e.g. a web
  // UI's `web-ui.*` host) — also ONCE, here at creation, never on a deploy. Skip
  // the primary (already registered above). Each extra carries its own service +
  // port. Like the primary, a deleted extra is never resurrected by a later
  // deploy. The `domains` table is the sole routing source from here on.
  for (const ex of input.extraDomains ?? []) {
    const host = ex.host.trim();
    if (host && host !== primaryName)
      await ensureExtraDomain(project.id, host, {
        port: ex.port,
        service: ex.service,
        // Passed so a globally-colliding template host regenerates a unique one.
        slug,
        ip,
        // Same TLS choice as the primary: a blueprint that expects HTTPS gets it
        // on every host it declares; anything else is born plain-HTTP.
        certProvider,
      });
  }

  // The display logo is auto-detected from the app's own files at DEPLOY
  // time (the deploy engine reads a git repo's tree via the GitHub API and scans
  // an upload's extracted tree), guarded so it only ever fills a still-empty
  // logo. A git/github app deploys immediately below, so its icon lands on
  // that first deploy; nothing to kick off here.
  // Kick off the first real build + deploy. Runs in the background and flips
  // the project to active (or error) once the container is up.
  //
  // `create_apps` is NOT `deploy_apps`: the two are separate permissions
  // precisely so a role can add an app without being allowed to ship code onto
  // the fleet, and creating one must not be the loophole that ships it anyway.
  // Asked ON THE NEW APP (a folder grant counts), and only after it exists.
  // Without it the app is born idle — exactly like a fileless upload — for
  // someone who can deploy to pick up.
  if (!isUpload && (await hasAppCapability(project.id, "deploy_apps"))) {
    await startDeployment(project.id, {
      environment: "production",
      creator: user.name,
      commitMessage: input.repo ? "Initial import" : "Initial deployment",
    });
  } else if (!isUpload) {
    await getDb()
      .update(appsTable)
      .set({ status: "idle", updatedAt: nowIso() })
      .where(eq(appsTable.id, project.id));
  }

  return summarizeOne((await loadAppGraph(project.id))!);
}

export async function updateAppBuild(
  id: string,
  build: Partial<BuildConfig>
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  // build.port is only WHICH container port Traefik routes to (routing), not a
  // published host port, so changing it isn't gated behind the expose-ports
  // grant — any member who can deploy may edit build settings.
  const user = (await getCurrentUser())!;
  // One tx (PLAN cut-set (c) Decision 15): the parent `app_build` columns
  // MERGE field-by-field, while a provided `methodSettings` object FULLY REPLACES
  // the 1-to-1 method-settings row.
  await getDb().transaction(async (tx) => {
    const existing = await loadAppGraph(id, tx);
    if (!existing || existing.teamId !== membership.teamId)
      throw new Error("App not found");
    const merged: BuildConfig = {
      ...existing.build,
      ...build,
      // methodSettings replaces wholesale when provided, else keep the existing.
      methodSettings: build.methodSettings ?? existing.build.methodSettings,
      // The pending cache clear is armed by clearAppBuildCache and consumed by
      // the next build — never by a build-settings save. Saving the form while a
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
  await recordActivity("app", `Updated build settings`, user.name, id);
}

/**
 * Clear this app's build cache: arm the one-shot flag the NEXT build consumes,
 * so that build reads nothing from the cache and rewrites what it replaces.
 *
 * There is deliberately nothing to delete here. The BuildKit cache lives on the
 * SERVER and is shared by every app on it (and, on a managed deplo, by other
 * tenants), so pruning it from one app's settings page would quietly slow down
 * everyone else's next deploy — an app can only clear its OWN cache by refusing
 * to read it once. Reclaiming disk stays the server-wide Docker cleanup's job.
 *
 * Idempotent: clearing twice before a deploy is still one cache-less build.
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
 * Choose where this app COMPILES, and what happens when that host is unreachable.
 *
 * `buildServerId` null is Automatic: use a build-only server if the fleet has one
 * this team can reach whose architecture matches, otherwise build where the app
 * runs. Passing the app's OWN server id is the explicit opt-out - "always build
 * here" - and is stored as that id rather than a sentinel.
 *
 * Validated against the servers this team can actually reach, so a crafted request
 * cannot point an app's build (with its source and decrypted env) at a host the
 * team was never granted. A storage-only host is refused too: no Docker, no build.
 *
 * `configure_apps`, like every other app setting. Deliberately NOT a deploy trigger:
 * changing where the next build happens should not start one.
 */
export async function setAppBuildServer(
  id: string,
  input: { buildServerId: string | null; buildFallbackLocal?: boolean },
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
      throw new Error("That server holds backups only - it has no Docker to build with.");
    buildServerId = picked.id;
  }
  await getDb()
    .update(appsTable)
    .set({
      buildServerId,
      ...(input.buildFallbackLocal === undefined
        ? {}
        : { buildFallbackLocal: input.buildFallbackLocal }),
      updatedAt: nowIso(),
    })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));

  const where =
    buildServerId === null
      ? "automatically"
      : buildServerId === project.serverId
        ? "on its own server"
        : `on ${(await getServerById(buildServerId))?.name ?? buildServerId}`;
  await recordActivity("app", `Set ${project.name} to build ${where}`, user.name, id);
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
 * Drop any repo credential that does not belong to this team.
 *
 * A GitHub installation and a git connection are both team-scoped tokens, and
 * both arrive as a plain id in a client request - so without this, a crafted
 * payload could point an app at ANOTHER team's credential and have Deplo clone
 * their private repository with it. Dropping the id (rather than failing) leaves
 * an anonymous clone, which is exactly right for a public repo and gives a clear
 * "authentication failed" for a private one.
 *
 * Called before the transaction, never inside one: it runs its own queries.
 */
async function scopeRepoCredentials(
  repo: GitRepo | null,
  teamId: string,
): Promise<GitRepo | null> {
  if (!repo) return null;
  const out: GitRepo = { ...repo };
  if (out.installationId) {
    const mine = await listGithubInstallations();
    if (!mine.some((i) => i.id === out.installationId)) out.installationId = null;
  }
  if (out.connectionId && !(await gitConnectionInTeam(out.connectionId, teamId))) {
    out.connectionId = null;
  }
  return out;
}

export async function updateAppSource(
  id: string,
  input: UpdateSourceInput
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  // A prebuilt image ref is interpolated raw into the compose `image:` scalar, so
  // reject anything that isn't a plain reference before it can inject service keys.
  if (input.source === "docker-image" && input.dockerImage && !IMAGE_REF_RE.test(input.dockerImage))
    throw new Error("Enter a valid image reference (e.g. nginx:1.27 or ghcr.io/org/app@sha256:…).");
  // Saving compose YAML that publishes ports (`ports:`/`expose:`) requires the
  // expose-ports grant. Routing (the Traefik domains) lives in the `domains`
  // table, not here, and is NOT port publishing — so it isn't gated here.
  if (input.compose != null && composePublishesPorts(input.compose)) {
    await requireExposePorts();
  }
  // Saving compose YAML that bind-mounts a host path requires the host grant —
  // and so does asking for host privileges (`privileged`, `cap_add`, `devices`,
  // `pid: host`, …), which reach the host without naming a path at all.
  if (
    input.compose != null &&
    (composeHasHostBindMount(input.compose) ||
      composeNeedsHostPrivileges(input.compose))
  ) {
    await requireMountHostVolumes();
  }
  const user = (await getCurrentUser())!;
  const repo = await scopeRepoCredentials(input.repo, membership.teamId);
  // Team-scoped picklist: a move can only target a server this team may use.
  // The project's current server is always in here (revoking a team's access is
  // blocked while it has workloads on the server), so the old-IP lookup is safe.
  const serversById = new Map(
    (await listServersForTeam(membership.teamId)).map((s) => [s.id, s] as const),
  );
  // Set inside the tx, consumed after commit to trigger the move's deploy.
  let migrateFromServerId: string | null = null;
  // The repo this app deployed from BEFORE this save, so its push webhook can be
  // withdrawn after the commit when the app stops pointing at it. Held in an
  // object because a bare `let` assigned inside the callback narrows to `null`.
  const before: { repo: GitRepo | null } = { repo: null };
  await getDb().transaction(async (tx) => {
    const p = await loadAppGraph(id, tx);
    if (!p || p.teamId !== membership.teamId) throw new Error("App not found");
    before.repo = p.repo;
    // Capture the OLD server IP before serverId is reassigned, so a move can
    // re-host the project's auto nip.io domains onto the new server's IP below.
    const oldIp = resolveServerIp(serversById.get(p.serverId));
    const oldServerId = p.serverId;
    let serverId = p.serverId;
    if (input.serverId) {
      if (!serversById.has(input.serverId)) throw new Error("Server not found");
      serverId = input.serverId;
    }
    const isMove = serverId !== oldServerId;
    // On a MOVE, if the app was ever deployed (it may hold data on the old
    // host), mark the OLD server as the migration source: the deploy we trigger on
    // the new host below will copy the data volumes + files dir across once its
    // fresh stack is up (completePendingAppMigration). A never-deployed app
    // has no data, so it just moves cheaply with no marker. `latestDeploymentId`
    // being set is the "was deployed" signal.
    migrateFromServerId = isMove && p.latestDeploymentId ? oldServerId : null;

    // MOVING the project to a different server: its auto nip.io domains encode
    // the OLD server's IP (as the trailing hex label), so re-host them onto the
    // new server's IP — otherwise the Domains section (and Traefik's routing
    // target) keeps pointing at the old host. Only the hex IP is swapped; the
    // random words are preserved, so the host stays recognisably the same
    // project's. The `domains` table is the sole routing source, so rehosting its
    // rows is all that's needed. A no-op when the IP is unchanged or the host
    // isn't nip.io.
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
      isMove && p.buildServerId === oldServerId ? serverId : (p.buildServerId ?? null);

    await tx
      .update(appsTable)
      .set({
        serverId,
        buildServerId,
        // Record the migration source on a move (null clears any stale marker on a
        // non-move edit). The post-commit deploy consumes it.
        migrateFromServerId,
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
        ...(input.compose != null ? { compose: input.compose } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(appsTable.id, id));
  });
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
  // A MOVE takes effect on a deploy (the container physically relocates to the new
  // host on the next build). Trigger it here so the move actually happens — and so
  // the data migration runs when that deploy succeeds (it consumes the marker set
  // above). Fire-and-forget, mirroring how creation deploys (startDeployment floats
  // runDeployment). A non-move source edit is NOT auto-deployed (unchanged
  // behavior); the user deploys when ready.
  //
  // Exception — the upload source: its deploy is driven explicitly (the settings
  // "Save & Deploy" button calls this to persist the move, then redeploys). That
  // redeploy consumes the same migration marker, so auto-deploying here too would
  // double-fire. Leave the marker set and let the caller's deploy complete the move.
  if (migrateFromServerId && input.source !== "upload") {
    try {
      await startDeployment(id, {
        creator: user.name,
        commitMessage: "Move to a different server",
      });
    } catch (e) {
      // The move (serverId + migration marker) is already committed, but the deploy
      // that would relocate the container + migrate the data failed to start. The
      // state is RECOVERABLE — the marker persists, so a manual production deploy
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
// cap all live in `lib/apps/volume-model.ts` — the SAME constants the Storage
// editor lints against, so the form cannot accept a mount this writer will
// refuse. Only the messages differ (API errors here, typing help there).

/**
 * Validate + canonicalize the full volume set for an app.
 * The renderer trusts its input, so EVERY safety rule lives here:
 *  - mountPath absolute, no spaces, no ":" (would smuggle a `:ro`/extra field
 *    into the compose `- name:path` string), no "..", not a reserved path.
 *  - no mountPath collision with a template `mounts[].filePath` (those are
 *    bind-mounted config files written next to the stack).
 *  - name lowercased, `[a-z0-9][a-z0-9_-]*`, ≤40 (blocks YAML key injection into
 *    the top-level `  <name>:` map), derived from the path when blank.
 *  - name unique within the project; mountPath unique within the SERVICE it
 *    mounts into (a compose stack may legitimately give two services their own
 *    `/data` — a single-container app has one service, so this is the old
 *    project-wide rule for it).
 *  - `service` (compose stacks only) names a service the compose actually
 *    declares, so the deploy can never fail on a stale name; `composeServices`
 *    null ⇒ single-container, where the field is meaningless and is dropped.
 * For a HOST bind mount (`type: "host"`) the `hostPath` SOURCE is validated to be
 * an absolute path with no spaces/":"/".." (so it can't smuggle extra compose
 * fields) — but it is intentionally NOT subject to RESERVED_MOUNT_PREFIXES (those
 * guard the in-container target; a privileged user picks the host source on
 * purpose). The grant check that authorizes host mounts lives in the CALLER
 * (setAppVolumes), not here, so this stays a pure validator usable in tests.
 * Empty result ⇒ null so renderCompose stays byte-identical. Exported for tests.
 */
export function validateVolumes(
  raw: VolumeMount[],
  existingMounts: { filePath: string }[] | null | undefined,
  composeServices?: string[] | null,
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
    if (!/^\/[^\s:]*$/.test(mountPath) || mountPath.length < 2) {
      throw new Error(
        `Mount path must be an absolute path with no spaces or ":": "${v.mountPath}"`,
      );
    }
    if (mountPath.split("/").includes("..")) {
      throw new Error(`Mount path must not contain "..": "${v.mountPath}"`);
    }
    if (
      RESERVED_MOUNT_PREFIXES.some(
        (r) => mountPath === r || mountPath.startsWith(r + "/"),
      )
    ) {
      throw new Error(`Mount path "${mountPath}" is reserved by the system.`);
    }
    // A volume conflicts with a template config file when their paths are equal,
    // when the volume is INSIDE a config file's dir, OR when the volume's dir
    // would SHADOW (contain) a config file — any of which breaks the bind-mount.
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

    const name = ((v.name ?? "").trim() || deriveVolumeName(mountPath)).toLowerCase();

    if (v.type === "app") {
      // Bind a path INSIDE the project's isolated files dir. The source is
      // relative (no leading "/") and must stay in the sandbox — a ".." segment
      // would climb out, which is exactly what we forbid (a rename could then
      // repoint it at another project). No top-level volumes entry is emitted;
      // renderCompose resolves it to the absolute files dir at deploy time.
      // Accept an optional `./` prefix (the same marker the compose convention
      // uses) but NOT a leading `/` — an absolute source is a host path, which
      // must be declared as type:"host" so it goes through the permission gate.
      const projectPath = (v.projectPath ?? "")
        .trim()
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, "");
      if (projectPath === "" || projectPath.startsWith("/")) {
        throw new Error(
          `The path in this app's Files must be relative, for example "config.toml": "${v.projectPath}"`,
        );
      }
      if (/[\s:]/.test(projectPath)) {
        throw new Error(
          `The path in this app's Files cannot contain spaces or ":": "${v.projectPath}"`,
        );
      }
      if (projectPath.split("/").includes("..")) {
        throw new Error(`The path in this app's Files cannot contain "..": "${v.projectPath}"`);
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
      // checked — the source is a deliberate host path. No top-level volumes
      // entry is emitted, so docker-name rules don't apply.
      const hostPath = (v.hostPath ?? "").trim().replace(/\/+$/, "");
      if (!/^\/[^\s:]*$/.test(hostPath) || hostPath.length < 2) {
        throw new Error(
          `The path on the server must be absolute, with no spaces or ":": "${v.hostPath}"`,
        );
      }
      if (hostPath.split("/").includes("..")) {
        throw new Error(`The path on the server cannot contain "..": "${v.hostPath}"`);
      }
      // Propagation rides into the compose mount line verbatim, so it is checked
      // against the closed set here too and not only at the API's enum: this
      // function is the boundary every writer goes through.
      const propagation = v.propagation;
      if (propagation && !MOUNT_PROPAGATIONS.includes(propagation)) {
        throw new Error(
          `Unknown mount propagation "${propagation}" — use ${MOUNT_PROPAGATIONS.join(" or ")}.`,
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
 * Replace an app's volumes (full set) — docker-managed named volumes, binds into
 * the app's files dir, and (for privileged users) host bind mounts. Works for
 * EVERY source, compose stacks included: requiring the user to hand-write
 * `volumes:` into their YAML is exactly the Docker knowledge deplo exists to not
 * demand. For a compose stack each row also carries the service it mounts into
 * (blank ⇒ the stack's default service), validated here against the compose so a
 * stale name can never surface as a deploy failure. An empty set is stored as
 * null so the renderers stay byte-identical. Persists only; the new mounts take
 * effect on the next production deploy (consistent with the other per-card
 * settings mutations).
 */
export async function setAppVolumes(
  id: string,
  volumes: VolumeMount[],
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
    const validated = validateVolumes(volumes, p.mounts, composeServices);
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

// A limit is a guard rail, not a quota — bounds are deliberately generous. We
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
    throw new Error('CPU pinning must be a core list like "0", "0,2" or "0-3".');
  }
  return s;
}

/**
 * Normalize + validate a {@link ResourceLimitsInput} into a full
 * {@link ResourceLimits}. PURE (no DB / no auth) so it unit-tests directly and
 * runs identically on the write path. Throws a user-facing `Error` (surfaced via
 * the mutation's toast) on any value Docker's `compose up` would reject; an
 * all-null input validates to an all-null result ("no limits set").
 */
export function cleanResourceLimits(input: ResourceLimitsInput): ResourceLimits {
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
  const oomScoreAdj = intLimit(input.oomScoreAdj, "OOM score adjust", -1000, 1000);

  // Cross-field coherence — Docker rejects these combinations outright, so we
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
        "Set a memory limit before a swap limit — the swap value is the memory + swap total.",
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
  await updateAppOwned(id, membership.teamId, {
    ...resourceLimitsToRow(cleaned),
    updatedAt: nowIso(),
  });
  await recordActivity("app", "Updated resource limits", user.name, id);
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
  await recordActivity("app", `Renamed project to ${clean}`, user.name, id);
}

/**
 * Set (or clear) the project's display logo. An empty value clears it, falling
 * the UI back to a generic icon. The logo is stored INLINE on the project
 * as a base64 image data-URI (uploaded image) or a local /templates path
 * (template default) — never a remote URL, so it renders under the strict CSP
 * with no cross-origin fetch (see {@link isValidLogoValue}). Purely cosmetic:
 * it never touches the deploy source or the Docker image the stack runs.
 *
 * No-op (no updatedAt bump, no activity record) when the value is unchanged, so
 * an idle Save doesn't reorder the dashboard or write a spurious log line.
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
    .set({ logo: next, updatedAt: nowIso() })
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
  await recordActivity("app", `Updated project logo`, user.name, id);
}

/**
 * Why detection came up empty, in the terms of where it actually looked. A
 * compose app is read twice — its own files AND the icon the running app serves
 * — so telling that user we found "no file named favicon" would describe half
 * the search and point them at the wrong thing to fix.
 */
function noIconFoundMessage(app: Parameters<typeof detectAppFavicon>[0]): string {
  if (faviconSourceKind(app) === "app-files") {
    return "No icon found. deplo looked in this app's files and asked the running app for its favicon — check that the app is running and serves one.";
  }
  return "No file named favicon (SVG, PNG or ICO) found in this app's files";
}

/**
 * Re-run favicon auto-detection for an app on demand (the settings "Detect
 * from source" button) and, when one is found, set it as the logo — overwriting
 * any current inline value, since the user explicitly asked to detect. Throws a
 * friendly message when the source has no detectable icon so the caller can
 * surface it. Returns the detected logo data-URI.
 *
 * A template's icon is an ordinary inline image since the catalog moved to its
 * own service, so there is nothing special to protect here: the automatic hooks
 * still only ever fill a NULL logo, and this manual action is explicit intent.
 */
export async function redetectAppLogo(id: string): Promise<string> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId) {
    throw new Error("App not found");
  }
  // A compose stack is read on its own server — its files, and the icon the
  // running app serves — so its routed domains come along: they name the compose
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
  const primaryHost = domains.find((d) => d.primary)?.name ?? domains[0]?.name ?? "";
  // "We couldn't reach the server" must not be reported as "your app has no icon".
  const logo = await detectAppFavicon(project, routes, primaryHost).catch((e) => {
    if (e instanceof AgentUnreachableError) {
      throw new Error(
        "The server that runs this app didn't answer, so deplo couldn't read its files. It may be offline.",
        { cause: e },
      );
    }
    throw e;
  });
  if (!logo || !isValidLogoValue(logo)) {
    throw new Error(noIconFoundMessage(project));
  }
  await getDb()
    .update(appsTable)
    .set({ logo, updatedAt: nowIso() })
    .where(
      and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)),
    );
  await recordActivity("app", `Detected project logo from source`, user.name, id);
  publishAppChanged(id);
  return logo;
}

/**
 * Recognise the framework in a repository the user is ABOUT to deploy — the read
 * behind the new-app wizard's "Next.js" badge, before any app row exists. Pure
 * read: it stores nothing, and the value it returns is re-derived (and persisted)
 * by the app's first deploy anyway.
 *
 * Two gates, both real:
 *  - `deploy`, the same capability creating an app needs. Reading someone's
 *    repository through the team's GitHub App is not a view-only act.
 *  - the installation must belong to the ACTIVE TEAM. Installations are
 *    team-scoped, so an id from another team is dropped rather than used —
 *    otherwise a crafted request could borrow another team's token to read their
 *    private repo. Dropping it (instead of failing) degrades to the
 *    unauthenticated read, which is exactly right for a public repo.
 *
 * Null whenever there is nothing to recognise: a build method that isn't one of
 * the auto-detecting builders, a non-GitHub host, an unreadable repo, or a repo
 * with no framework in it.
 */
export async function previewRepoFramework(input: {
  repo: string;
  url?: string | null;
  branch?: string | null;
  installationId?: string | null;
  buildMethod: BuildMethod;
  rootDirectory?: string | null;
}): Promise<FrameworkId | null> {
  await requireCapability("create_apps");
  if (!supportsFrameworkDetection(input.buildMethod)) return null;

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
 * Correct the framework Deplo recognised in this app's source — or drop the
 * correction (`framework: null`) and go back to trusting detection.
 *
 * Written to its own column, never over `apps.framework`: the deploy keeps
 * re-detecting into that one, so a shared column would silently lose the choice
 * on the next push. Which one wins is {@link effectiveFramework}'s answer, not
 * this function's.
 *
 * Gated like every other build setting (`configure_apps` + the folder gate) — it
 * changes which port the app is routed on, so it is a configuration change, not
 * a label edit. An id the catalog doesn't know is refused rather than stored:
 * unlike a value detection wrote, this one comes from a client.
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
      : `Reset framework to what deplo detects`,
    user.name,
    id,
  );
  publishAppChanged(id);
}

/**
 * Set (or clear) the extra flags this app adds to its `docker compose up`.
 *
 * Validated here, not only in the form: the same value arrives from the bearer
 * API, and a bad one would reach a host's argv. The agent vets it a second time
 * and drops the whole set rather than half-applying it — see
 * lib/deploy/compose-args.ts for why those flags are additive by design.
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
 *
 * `configure_apps`, not `rollback_apps`: this is a RETENTION number - it decides
 * how many of the app's images stay on its server, i.e. how much disk it holds -
 * and retention belongs with the app's other settings. Being trusted to put the
 * app back on last week's build is not the same as being trusted to decide how
 * much of the host it occupies, which is why the two are separate permissions.
 *
 * Takes effect on the NEXT sweep, which is the one right after the next deploy:
 * lowering it does not reach out and delete images now, and raising it cannot
 * bring back ones already gone. Both are said in the UI rather than papered over.
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
    keep === 0
      ? "Turned rollbacks off"
      : `Set rollbacks kept to ${keep}`,
    user.name,
    id,
  );
  publishAppChanged(id);
}

/**
 * Set a project's status and notify every live subscriber.
 *
 * NOT gated and NOT team-scoped: every caller has already resolved this app
 * through a capability check (stop/start here, restore in `lib/data/backups.ts`),
 * and the write is unconditional on purpose — a read-then-decide would lose the
 * race against a deploy landing in the gap.
 */
export async function setAppStatus(id: string, status: AppStatus): Promise<void> {
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
  // is visible to every client immediately and survives a reload — not just a
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
  try {
    await startContainer(project.slug);
  } catch (e) {
    // Start failure (unreachable, or agent reported start failed): fail clearly
    // rather than marking it "active" falsely.
    throw new Error(
      `The stack on ${project.name}'s server was not started: ${errMsg(e)}`,
    );
  }
  await setAppStatus(id, "active");
  await recordActivity("app", `Started ${project.name}`, user.name, id);
}

/**
 * Rebuild the image from the current source and replace the running container —
 * a full deployment that also FORCES the container to be recreated.
 *
 * The force matters: `docker compose up -d` compares compose's own config hash
 * and does nothing when it matches, so for a compose stack or a prebuilt image
 * whose config had not moved, "Rebuild container" used to finish green with the
 * same container still running — the one case the button exists for. A source
 * Deplo builds tags a new image per deploy, so it recreated anyway; forcing it
 * only makes the promise the same for every source.
 */
export async function rebuildApp(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "deploy_apps");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(id, membership.teamId)))
    throw new Error("App not found");
  await startDeployment(id, {
    environment: "production",
    creator: user.name,
    commitMessage: "Rebuild container",
    forceRecreate: true,
  });
}

/**
 * Stamp `deleting_at` — the point of no return, written before a single byte is
 * torn down.
 *
 * From here the app is GONE as far as the product is concerned even though its
 * row is still there: `requireAppCapability` refuses it, its pages 404, and the
 * Overview keeps its card on screen dimmed and pulsing so the delete survives a
 * reload instead of serving back a live-looking app somebody can click into,
 * deploy, or delete a second time while the first teardown is still running.
 *
 * Nothing ever clears it: the only exit is the row going away.
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
 * Delete an app and WAIT for its host to be clear of it. The identity-free half
 * of the delete (`actor` is already resolved), so the boot reconcile can finish
 * a delete whose control plane died without a session to read.
 */
async function destroyApp(project: App, actor: string): Promise<void> {
  const id = project.id;
  // Tear down the running container/stack before dropping the records. A REMOTE
  // whose agent is unreachable can't be torn down now — proceed with the delete
  // anyway (P6 spirit: never leave records pinned to a dead box) and warn so the
  // operator cleans up the leftover containers by hand. The agent calls run
  // OUTSIDE any DB transaction (PLAN §1 rule (a): never wrap a gRPC dial in a tx).
  // Teardown + record delete run under the app's lifecycle lock (the SAME lock
  // tryAgent takes before `compose up`): a delete issued during an in-flight
  // deploy WAITS for the agent bring-up, then tears down a fully-created stack;
  // and once the row is dropped here, a deploy still mid-build re-checks under the
  // lock and aborts instead of resurrecting the stack. Closes the orphan race the
  // keyed-mutex already prevents for databases.
  const tornDown = await withKeyedLock(`app-lifecycle:${id}`, async () => {
    // Pull request previews FIRST: the DELETE below cascades their rows away,
    // and with them the only record that those containers and volumes exist.
    await destroyPreviewsForApp(id).catch(() => {});
    // `removeVolumes` - deleting an app takes its data with it.
    //
    // It used to be left off, on the reading that a named volume holds data the
    // operator might want back. But nothing ever gave it back: no screen listed
    // an orphaned volume, nothing reclaimed one, and the docker cleanup refuses
    // volume pruning by design. So "kept" meant an invisible, unreclaimable pile
    // that grew by one app's worth every time somebody deleted an app - 45 of
    // them on the instance where this was found.
    //
    // The safety net for a delete you regret is the BACKUP, which is a thing you
    // can see, download and restore. A volume nobody can name is not one.
    // Compose never removes an `external:` volume, so a pre-existing host volume
    // the app merely referenced still survives, which is right: Deplo does not
    // own those.
    const ok = await teardownApp(project.slug, { removeVolumes: true });
    // Drop any uploaded archive backing an "upload" source.
    await removeUploads(id).catch(() => {});
    // One DELETE — the FK CASCADEs do the rest: deployments (+ logs), env_vars
    // (+ targets), domains (+ middlewares), the 6 project child tables, the
    // team_app_order rows, AND shared_env_var_apps (the per-app shared-variable
    // links — the orphan the old JSONB deleteApp leaked is now impossible — PLAN §7
    // "the live cascade is fixed in cut-set (c)"). backups.project_id is SET NULL (history outlives the
    // project), so no project-target backup is orphaned either.
    await getDb().delete(appsTable).where(eq(appsTable.id, id));
    return ok;
  });
  const server = await getServerById(project.serverId);
  if (!tornDown && server) {
    await recordActivity(
      "app",
      `Deleted ${project.name} but its server (${server.name}) was unreachable — ` +
        `leftover containers on that host must be removed manually.`,
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
 * Delete an app, waiting for the host to be clear of it — the whole operation in
 * one await, for a caller that has no response to get out of the way of (a
 * script, a test asserting the cascade). Anything serving a user wants
 * {@link startAppDelete} instead.
 */
export async function deleteApp(id: string): Promise<void> {
  const { project, actor } = await beginAppDelete(id);
  await destroyApp(project, actor);
}

/**
 * The same delete, minus the wait — what the dashboard calls.
 *
 * The app is stamped (and therefore locked everywhere, on every client, across
 * a reload) before this returns; the teardown finishes behind the response.
 * Deleting a stack takes seconds on a healthy host and up to the agent dial
 * timeout on an unreachable one, which is a long time to hold someone in front
 * of a spinner over a decision they have already confirmed and cannot undo.
 *
 * The teardown's failure is not the caller's to handle: by the time it can fail
 * the delete is already irreversible, so it is logged, the row keeps its stamp,
 * and {@link resumeAppDeletes} retries it at the next boot.
 */
export async function startAppDelete(id: string): Promise<void> {
  const { project, actor } = await beginAppDelete(id);
  void destroyApp(project, actor).catch((e) =>
    console.error(`[deplo] delete of ${project.name} did not finish:`, errMsg(e)),
  );
}

/**
 * Bulk-delete several apps. Tears down each project's stack with BOUNDED
 * concurrency (so a large multi-select can't flood one server's agent with
 * simultaneous teardowns), then removes ALL their records in a SINGLE store write
 * — one document persist + one activity row, instead of N independent
 * `deleteApp` round-trips. Team-scoped; unknown/foreign ids are ignored.
 * Returns the number actually deleted.
 */
export async function deleteApps(ids: string[]): Promise<number> {
  const { apps, actor } = await beginAppsDelete(ids);
  if (apps.length === 0) return 0;
  await destroyApps(apps, actor);
  return apps.length;
}

/**
 * The bulk delete the dashboard calls — the multi-select twin of
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
  // access, and since ADR-0016 `delete_apps` can be held on one app alone — so
  // the question has to be asked per app rather than once for the team.
  for (const p of apps) {
    await requireAppCapability(p.id, "delete_apps");
  }
  await markAppsDeleting(apps.map((p) => p.id));
  return { apps, actor: user.name };
}

/** The identity-free teardown half of {@link deleteApps}. */
async function destroyApps(apps: App[], actor: string): Promise<void> {
  const serversById = new Map((await listAllServers()).map((s) => [s.id, s] as const));
  // Tear down stacks ≤4 at a time (agent calls OUTSIDE any tx). A throw/
  // unreachable for one project must not abort the others or the record removal.
  // Each project's teardown + its OWN record delete run under that project's
  // lifecycle lock (see deleteApp/tryAgent), so a concurrent deploy of any of
  // these apps can't resurrect an orphaned stack. FK CASCADEs remove every child
  // + the shared-group attachments (no orphan); backups.project_id SET NULL keeps
  // history.
  const unreachable: string[] = [];
  await mapLimit(apps, 4, async (project) => {
    const tornDown = await withKeyedLock(`app-lifecycle:${project.id}`, async () => {
      // Preview stacks first — see deleteApp.
      await destroyPreviewsForApp(project.id).catch(() => {});
      // Volumes go too - see deleteApp for why "keeping" them was not a kindness.
      const ok = await teardownApp(project.slug, { removeVolumes: true }).catch(
        () => false,
      );
      await removeUploads(project.id).catch(() => {});
      await getDb().delete(appsTable).where(eq(appsTable.id, project.id));
      return ok;
    });
    if (!tornDown) {
      const server = serversById.get(project.serverId);
      if (server) unreachable.push(`${project.name} (${server.name})`);
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
      `Some servers were unreachable during bulk delete — leftover containers may ` +
        `remain and must be removed manually: ${unreachable.join(", ")}`,
      actor,
      null,
      apps[0]!.teamId,
    );
  }
}

/**
 * Finish the deletes a dead control plane left stamped.
 *
 * A teardown runs behind the response (see {@link startAppDelete}), so a restart
 * in the middle of one loses the only thing that was going to remove the stack —
 * and the app would sit stamped forever: refused by every gate, pulsing on the
 * Overview, with nothing left to finish it. Boot picks them back up, exactly
 * like the deployment and backup reconciles next to it.
 *
 * Identity-free by construction (the actor is "Deplo"): there is no session at
 * boot, and the gate was already passed by whoever confirmed the delete.
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
      console.error(`[deplo] could not finish deleting ${project.name}:`, errMsg(e)),
    );
  }
}

/** The lifecycle actions a folder or a project runs over all of its apps at once. */
export type BulkAppAction = "start" | "stop" | "restart" | "redeploy";

/**
 * Run ONE lifecycle action on every app in a folder (its whole subtree, the
 * same apps its tile counts) or in a project (every environment).
 *
 * It only fans out: each app goes through the SAME per-app function the
 * single-app menu calls, so the capability gate, the status writes and the
 * activity trail are identical, and a member who holds the capability on one
 * corner of the fleet acts on exactly that corner. Apps the caller can't reach
 * are skipped: they don't exist for them, and a count is no place to learn
 * otherwise. One app refusing, or its host being unreachable, is counted and
 * never aborts the rest. Bounded to 4 at a time like {@link deleteApps}, so one
 * click can't flood a host's agent.
 *
 * Returns the counts plus the FIRST failure message, so the UI can say
 * "Stopped 3 of 5 apps" in the server's own words.
 */
export async function bulkAppAction(
  action: BulkAppAction,
  scope: { folderId?: string | null; projectId?: string | null },
): Promise<{ ok: number; failed: number; error: string | null }> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;

  if (!scope.folderId && !scope.projectId)
    throw new Error("Pick a folder or a project to act on");
  // Both branches count their WHOLE subtree on the tile, so the action has to
  // reach the same apps: nothing nested may sit out a "Stop all".
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
  const where = and(
    eq(appsTable.teamId, teamId),
    scope.folderId
      ? inArray(appsTable.folderId, folderIds)
      : folderIds.length > 0
        ? or(
            eq(appsTable.projectId, scope.projectId!),
            inArray(appsTable.folderId, folderIds),
          )
        : eq(appsTable.projectId, scope.projectId!),
  );

  const rows = await getDb()
    .select({
      id: appsTable.id,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(where);
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
