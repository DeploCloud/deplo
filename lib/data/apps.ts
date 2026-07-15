import "server-only";

import { cache } from "react";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  listAllServers,
  listServersForTeam,
  getServerById,
  assertServerAccessibleTx,
} from "./servers";
import { getDb } from "../db/client";
import {
  domains as domainsTable,
  apps as appsTable,
  appBuild as appBuildTable,
  appBuildMethodSettings as appBuildMethodSettingsTable,
  appMounts as appMountsTable,
  appVolumes as appVolumesTable,
  teamAppOrder,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireExposePorts,
  requireMountHostVolumes,
  isInstanceAdmin,
} from "../membership";
import {
  composeHasHostBindMount,
  composePublishesPorts,
} from "../deploy/compose-lint";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import { buildConfigFor } from "../frameworks";
import type {
  BuildConfig,
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
import {
  resolveServerIp,
  instanceHost,
  rehostNip,
  rehostBlueprintHosts,
  nipEmbeddedIp,
} from "../deploy/domains";
import { teardownApp } from "./deployments";
import { agentTeardownDev } from "../deploy/agent-dev";
import { removeUploads } from "../deploy/upload";
import { removeAppDevSshUsers } from "./dev-ssh";
import { isValidLogoValue, isTemplateLogo } from "../apps/logo-shared";
import { detectAppFavicon } from "../apps/favicon-detect";
import { publishAppChanged } from "../graphql/pubsub";
import {
  insertEnvVars,
  loadDomainsForApp,
  loadAppGraph,
  loadAppGraphBySlug,
  loadAppsByIds,
  loadAppsByTeam,
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
import { requireFolderCapabilityForApp } from "./folder-access";

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
 * Map a project's persisted status to the status callers should see, self-
 * healing a wedged "stopping". Exported for unit tests; pure (no store/docker).
 */
export function reconcileStatus(
  status: AppStatus,
  updatedAt: string,
  now: number = Date.now(),
): AppStatus {
  if (status !== "stopping") return status;
  const age = now - new Date(updatedAt).getTime();
  return age > STOPPING_STALE_MS ? "idle" : "stopping";
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

export async function listApps(): Promise<AppSummary[]> {
  const teamId = await requireActiveTeamId();
  const [proj, rank] = await Promise.all([
    loadAppsByTeam(teamId),
    appOrderRank(teamId),
  ]);
  const pre = await preloadSummaries(proj);
  // Honour the team's manual order (Overview drag-and-drop) when present:
  // explicitly-ordered apps come first in that order, anything not listed
  // (a brand-new project, or before any reorder) falls back to newest-first.
  return proj
    .map((p) => summarize(p, pre))
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
  return p && p.teamId === teamId ? summarizeOne(p) : null;
});

export async function getAppById(id: string): Promise<App | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadAppGraph(id);
  return p && p.teamId === teamId ? p : null;
}

/**
 * App summary by id for an already-resolved team, WITHOUT reading the
 * request's cookies. The live `appStatus` subscription resolves the caller's
 * team once from the GraphQL context (`ctx.teamId`, established in request
 * scope) and then reloads snapshots through this seam on each change — Next's
 * `cookies()` is NOT callable across the async-iteration ticks of a long-lived
 * SSE response (it runs after the request scope closes), so the team is passed
 * explicitly rather than re-derived. The same applies to the slug lookup below.
 * Stays cookie-free: it queries Postgres with the passed `teamId` directly and
 * never calls `requireActiveTeamId()` / a cookie-reading helper (PLAN §6 "SSE
 * generators must stay cookie-free").
 */
export async function summarizeForTeam(
  id: string,
  teamId: string,
): Promise<AppSummary | null> {
  const p = await loadAppGraph(id);
  return p && p.teamId === teamId ? summarizeOne(p) : null;
}

/** Cookie-free slug → summary lookup scoped to an explicit team (see above). */
export async function findAppSummaryBySlugForTeam(
  slug: string,
  teamId: string,
): Promise<AppSummary | null> {
  const p = await loadAppGraphBySlug(slug);
  return p && p.teamId === teamId ? summarizeOne(p) : null;
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
}

export async function createApp(
  input: CreateAppInput
): Promise<AppSummary> {
  const { membership, userId } = await requireCapability("deploy");
  // Publishing container ports — a service's `ports:` (bound to the host) or
  // `expose:` (advertised to linked containers) — needs the expose-ports grant.
  // Giving a service a public Traefik DOMAIN (composeService/composePort/exposes)
  // is routing, NOT port publishing, so it is intentionally NOT gated here.
  if (input.compose != null && composePublishesPorts(input.compose)) {
    await requireExposePorts();
  }
  // A host bind mount baked into the initial compose needs the host-volume grant.
  if (input.compose != null && composeHasHostBindMount(input.compose)) {
    await requireMountHostVolumes();
  }
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
  const server =
    (input.serverId && servers.find((s) => s.id === input.serverId)) ||
    servers[0];
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
    // New apps start ungrouped (top level); a folder is assigned later from
    // the Overview (drag-into-folder or the card's "Move to folder" menu).
    folderId: null,
    serverId: server.id,
    // Defaulted from a template's logo (a /templates path); ignore anything that
    // isn't a valid inline logo so a crafted create payload can't store a URL.
    logo: input.logo && isValidLogoValue(input.logo) ? input.logo : null,
    source: input.source,
    repo: input.repo,
    dockerImage: input.dockerImage ?? null,
    upload: null,
    compose: input.compose ?? null,
    mounts: input.mounts?.length ? input.mounts : null,
    build: buildConfigFor(input.build),
    dev: null,
    productionUrl: null,
    status: isUpload ? "idle" : "queued",
    autoDeploy: input.autoDeploy ?? true,
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
    .map((e) => ({
      id: newId("env"),
      appId: project.id,
      key: e.key.trim(),
      valueEnc: encryptSecret(e.value),
      targets: ["production", "preview", "development"] as EnvTarget[],
      type: isSecretKey(e.key) ? ("secret" as const) : ("plain" as const),
      // A template's defaults are still an authored write by whoever created the app.
      createdByUserId: userId,
      updatedByUserId: userId,
      createdAt: now,
      updatedAt: now,
    }));

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
        await tx.insert(appsTable).values(appToRow(project));
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
  const primaryName = await ensureAutoDomain(project.id, {
    slug,
    ip,
    preferred: input.autoDomain ?? undefined,
    defaultPort: detected?.port ?? project.build.port,
    defaultApp: detected?.service ?? null,
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
      });
  }

  // The display logo is auto-detected from the app's own files at DEPLOY
  // time (the deploy engine reads a git repo's tree via the GitHub API and scans
  // an upload's extracted tree), guarded so it only ever fills a still-empty
  // logo. A git/github app deploys immediately below, so its icon lands on
  // that first deploy; nothing to kick off here.
  if (!isUpload) {
    // Kick off the first real build + deploy. Runs in the background and flips
    // the project to active (or error) once the container is up.
    await startDeployment(project.id, {
      environment: "production",
      creator: user.name,
      commitMessage: input.repo ? "Initial import" : "Initial deployment",
    });
  }

  return summarizeOne((await loadAppGraph(project.id))!);
}

export async function updateAppBuild(
  id: string,
  build: Partial<BuildConfig>
): Promise<void> {
  const { membership } = await requireCapability("deploy");
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
    await requireFolderCapabilityForApp(id, "deploy");
    const merged: BuildConfig = {
      ...existing.build,
      ...build,
      // methodSettings replaces wholesale when provided, else keep the existing.
      methodSettings: build.methodSettings ?? existing.build.methodSettings,
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

export interface UpdateSourceInput {
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  serverId?: string;
  /** Compose YAML to persist (source === "compose"). Kept when switching away. */
  compose?: string | null;
}

export async function updateAppSource(
  id: string,
  input: UpdateSourceInput
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  // Saving compose YAML that publishes ports (`ports:`/`expose:`) requires the
  // expose-ports grant. Routing (the Traefik domains) lives in the `domains`
  // table, not here, and is NOT port publishing — so it isn't gated here.
  if (input.compose != null && composePublishesPorts(input.compose)) {
    await requireExposePorts();
  }
  // Saving compose YAML that bind-mounts a host path requires the host grant.
  if (input.compose != null && composeHasHostBindMount(input.compose)) {
    await requireMountHostVolumes();
  }
  const user = (await getCurrentUser())!;
  // Team-scoped picklist: a move can only target a server this team may use.
  // The project's current server is always in here (revoking a team's access is
  // blocked while it has workloads on the server), so the old-IP lookup is safe.
  const serversById = new Map(
    (await listServersForTeam(membership.teamId)).map((s) => [s.id, s] as const),
  );
  // Set inside the tx, consumed after commit to trigger the move's deploy.
  let migrateFromServerId: string | null = null;
  await getDb().transaction(async (tx) => {
    const p = await loadAppGraph(id, tx);
    if (!p || p.teamId !== membership.teamId) throw new Error("App not found");
    await requireFolderCapabilityForApp(id, "deploy");
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

    await tx
      .update(appsTable)
      .set({
        serverId,
        // Record the migration source on a move (null clears any stale marker on a
        // non-move edit). The post-commit deploy consumes it.
        migrateFromServerId,
        source: input.source,
        repoProvider: input.repo?.provider ?? null,
        repoUrl: input.repo?.url ?? null,
        repoRepo: input.repo?.repo ?? null,
        repoBranch: input.repo?.branch ?? null,
        repoInstallationId: input.repo?.installationId ?? null,
        repoTriggerType: input.repo?.triggerType ?? null,
        repoWatchPaths: input.repo?.watchPaths?.length
          ? input.repo.watchPaths.join("\n")
          : null,
        repoSubmodules: input.repo?.submodules ?? false,
        dockerImage: input.dockerImage,
        // Persist compose edits when provided; never clear a stored stack on
        // switch so the user can flip back to Compose and recover it.
        ...(input.compose != null ? { compose: input.compose } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(appsTable.id, id));
  });
  await recordActivity("app", `Updated deploy source`, user.name, id);
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

/**
 * Container paths the runtime owns; mounting a user volume over them would break
 * or compromise the container. Rejected (exact match or as a parent prefix).
 */
const RESERVED_MOUNT_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var/run",
];

/**
 * Validate + canonicalize the full volume set for a single-container project.
 * The renderer trusts its input, so EVERY safety rule lives here:
 *  - mountPath absolute, no spaces, no ":" (would smuggle a `:ro`/extra field
 *    into the compose `- name:path` string), no "..", not a reserved path.
 *  - no mountPath collision with a template `mounts[].filePath` (those are
 *    bind-mounted config files written next to the stack).
 *  - name lowercased, `[a-z0-9][a-z0-9_-]*`, ≤40 (blocks YAML key injection into
 *    the top-level `  <name>:` map), derived from the path when blank.
 *  - mountPath AND name unique within the project.
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
): VolumeMount[] | null {
  const seenPath = new Set<string>();
  const seenName = new Set<string>();
  const mountFilePaths = (existingMounts ?? []).map((m) => m.filePath);
  const out: VolumeMount[] = [];
  for (const v of raw) {
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
    if (seenPath.has(mountPath)) {
      throw new Error(`Duplicate mount path: "${mountPath}"`);
    }
    seenPath.add(mountPath);

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
          `App path must be relative to the project's files dir, e.g. "config.toml": "${v.projectPath}"`,
        );
      }
      if (/[\s:]/.test(projectPath)) {
        throw new Error(
          `App path must not contain spaces or ":": "${v.projectPath}"`,
        );
      }
      if (projectPath.split("/").includes("..")) {
        throw new Error(`App path must not contain "..": "${v.projectPath}"`);
      }
      out.push({
        id: v.id || newId("vol"),
        type: "app",
        name,
        projectPath,
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
          `Host path must be an absolute path with no spaces or ":": "${v.hostPath}"`,
        );
      }
      if (hostPath.split("/").includes("..")) {
        throw new Error(`Host path must not contain "..": "${v.hostPath}"`);
      }
      out.push({
        id: v.id || newId("vol"),
        type: "host",
        name,
        hostPath,
        mountPath,
        readOnly: Boolean(v.readOnly),
      });
      continue;
    }

    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || name.length > 40) {
      throw new Error(
        `Volume name "${name}" must be lowercase letters, digits, "-"/"_" (max 40).`,
      );
    }
    if (seenName.has(name)) {
      throw new Error(`Duplicate volume name: "${name}"`);
    }
    seenName.add(name);

    out.push({ id: v.id || newId("vol"), name, mountPath, readOnly: Boolean(v.readOnly) });
  }
  return out.length ? out : null;
}

/**
 * Replace a single-container project's volumes (full set) — docker-managed named
 * volumes and (for privileged users) host bind mounts. Rejected for compose-stack
 * apps — they declare volumes inside their own YAML. An empty set is stored
 * as null so renderCompose stays byte-identical. Persists only; the new mounts
 * take effect on the next production deploy (consistent with the other per-card
 * settings mutations).
 */
export async function setAppVolumes(
  id: string,
  volumes: VolumeMount[],
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  // A host bind mount escapes the per-project sandbox, so it needs the dedicated
  // grant on top of `deploy` (instance admins hold it implicitly).
  if (volumes.some((v) => v.type === "host")) {
    await requireMountHostVolumes();
  }
  const user = (await getCurrentUser())!;
  await getDb().transaction(async (tx) => {
    const p = await loadAppGraph(id, tx);
    if (!p || p.teamId !== membership.teamId) throw new Error("App not found");
    await requireFolderCapabilityForApp(id, "deploy");
    if (usesComposeStack(p)) {
      throw new Error(
        "Volumes are managed inside the compose file for this project.",
      );
    }
    // Validate against the project's mounts (the conflict check), then whole-set
    // replace the `app_volumes` ordered child rows.
    const validated = validateVolumes(volumes, p.mounts);
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
  const { membership } = await requireCapability("deploy");
  await requireFolderCapabilityForApp(id, "deploy");
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
  const { membership } = await requireCapability("deploy");
  await requireFolderCapabilityForApp(id, "deploy");
  const user = (await getCurrentUser())!;
  await updateAppOwned(id, membership.teamId, {
    source: "upload",
    uploadId: upload.id,
    uploadFilename: upload.filename,
    uploadPath: upload.path,
    uploadSize: upload.size,
    uploadUploadedAt: upload.uploadedAt,
    // Forget any repo / docker image so the deploy takes the upload branch.
    // Clear ALL eight flattened repo_* columns as one unit (matching appToRow
    // and updateAppSource) so no stale git deploy option is left orphaned on a
    // now-repoless app.
    repoProvider: null,
    repoUrl: null,
    repoRepo: null,
    repoBranch: null,
    repoInstallationId: null,
    repoTriggerType: null,
    repoWatchPaths: null,
    repoSubmodules: false,
    dockerImage: null,
    updatedAt: nowIso(),
  });
  await recordActivity("app", `Uploaded ${upload.filename}`, user.name, id);
}

export async function setAutoDeploy(id: string, value: boolean): Promise<void> {
  const { membership } = await requireCapability("deploy");
  await requireFolderCapabilityForApp(id, "deploy");
  await updateAppOwned(id, membership.teamId, {
    autoDeploy: value,
    updatedAt: nowIso(),
  });
}

export async function renameApp(id: string, name: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  await requireFolderCapabilityForApp(id, "deploy");
  const user = (await getCurrentUser())!;
  await updateAppOwned(id, membership.teamId, {
    name: name.trim(),
    updatedAt: nowIso(),
  });
  await recordActivity("app", `Renamed project to ${name}`, user.name, id);
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
  const { membership } = await requireCapability("deploy");
  await requireFolderCapabilityForApp(id, "deploy");
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
 * Re-run favicon auto-detection for an app on demand (the settings "Detect
 * from source" button) and, when one is found, set it as the logo — overwriting
 * any current inline value, since the user explicitly asked to detect. Throws a
 * friendly message when the source has no detectable icon so the caller can
 * surface it. Returns the detected logo data-URI.
 *
 * EXCEPTION: a template's default icon ALWAYS takes priority — detection never
 * replaces it. A template-sourced app keeps its bundled `/templates/...`
 * logo unless the user removes it first (then it's a normal empty logo and
 * detection may fill it). This mirrors the automatic hooks, which only ever fill
 * a NULL logo.
 */
export async function redetectAppLogo(id: string): Promise<string> {
  const { membership } = await requireCapability("deploy");
  await requireFolderCapabilityForApp(id, "deploy");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId) {
    throw new Error("App not found");
  }
  if (isTemplateLogo(project.logo)) {
    throw new Error(
      "This app keeps its template's default icon, which takes priority. Remove it first to detect one from your source files.",
    );
  }
  const logo = await detectAppFavicon(project);
  if (!logo || !isValidLogoValue(logo)) {
    throw new Error("No favicon (SVG or PNG) found in the app files");
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

/** Set a project's status and notify every live subscriber. */
async function setAppStatus(id: string, status: AppStatus): Promise<void> {
  await getDb()
    .update(appsTable)
    .set({ status, updatedAt: nowIso() })
    .where(eq(appsTable.id, id));
  publishAppChanged(id);
}

/** Stop the project's running container. */
export async function stopApp(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await requireFolderCapabilityForApp(id, "deploy");
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
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await requireFolderCapabilityForApp(id, "deploy");
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

/** Rebuild the image from the current source and redeploy (real build). */
export async function rebuildApp(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(id, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(id, "deploy");
  await startDeployment(id, {
    environment: "production",
    creator: user.name,
    commitMessage: "Rebuild container",
  });
}

export async function deleteApp(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await requireFolderCapabilityForApp(id, "deploy");
  // Tear down the running container/stack before dropping the records. A REMOTE
  // whose agent is unreachable can't be torn down now — proceed with the delete
  // anyway (P6 spirit: never leave records pinned to a dead box) and warn so the
  // operator cleans up the leftover containers by hand. The agent calls run
  // OUTSIDE any DB transaction (PLAN §1 rule (a): never wrap a gRPC dial in a tx).
  const tornDown = await teardownApp(project.slug);
  const server = await getServerById(project.serverId);
  if (!tornDown && server) {
    await recordActivity(
      "app",
      `Deleted ${project.name} but its server (${server.name}) was unreachable — ` +
        `leftover containers on that host must be removed manually.`,
      user.name,
      null,
    );
  }
  // Dev mode: tear down the dev container + deps volume + WIPE the workspace
  // (the project is gone), and remove this project's SSH users from the gateway
  // (which stays up — it is a platform singleton).
  await agentTeardownDev(project).catch(() => {});
  await removeAppDevSshUsers(id).catch(() => {});
  // Drop any uploaded archive backing an "upload" source.
  await removeUploads(id).catch(() => {});
  // One DELETE — the FK CASCADEs do the rest: deployments (+ logs), env_vars
  // (+ targets), domains (+ middlewares), the 6 project child tables, the
  // team_app_order rows, AND shared_env_var_apps (the per-app shared-variable
  // links — the orphan the old JSONB deleteApp leaked is now impossible — PLAN §7
  // "the live cascade is fixed in cut-set (c)"). backups.project_id is SET NULL (history outlives the
  // project), so no project-target backup is orphaned either.
  await getDb().delete(appsTable).where(eq(appsTable.id, id));
  await recordActivity("app", `Deleted project ${project.name}`, user.name, null);
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
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const idSet = [...new Set(ids)];
  // Team-scoped: only the caller's own apps, fully loaded for teardown.
  const apps = (await loadAppsByIds(idSet)).filter(
    (p) => p.teamId === membership.teamId,
  );
  if (apps.length === 0) return 0;

  // Folder-scope EACH project: a project inside a folder the caller can't access
  // may not be bulk-deleted through this path either.
  for (const p of apps) {
    await requireFolderCapabilityForApp(p.id, "deploy");
  }

  const serversById = new Map((await listAllServers()).map((s) => [s.id, s] as const));
  // Tear down stacks ≤4 at a time (agent calls OUTSIDE any tx). A throw/
  // unreachable for one project must not abort the others or the record removal.
  const unreachable: string[] = [];
  await mapLimit(apps, 4, async (project) => {
    const tornDown = await teardownApp(project.slug).catch(() => false);
    if (!tornDown) {
      const server = serversById.get(project.serverId);
      if (server) unreachable.push(`${project.name} (${server.name})`);
    }
    await agentTeardownDev(project).catch(() => {});
    await removeAppDevSshUsers(project.id).catch(() => {});
    await removeUploads(project.id).catch(() => {});
  });

  // One DELETE — FK CASCADEs remove every child + the shared-group attachments
  // (no orphan); backups.project_id SET NULL keeps history.
  const gone = apps.map((p) => p.id);
  await getDb().delete(appsTable).where(inArray(appsTable.id, gone));
  await recordActivity(
    "app",
    `Deleted ${apps.length} project${apps.length === 1 ? "" : "s"}`,
    user.name,
    null,
  );
  if (unreachable.length) {
    await recordActivity(
      "app",
      `Some servers were unreachable during bulk delete — leftover containers may ` +
        `remain and must be removed manually: ${unreachable.join(", ")}`,
      user.name,
      null,
    );
  }
  return apps.length;
}
