import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { read } from "../store";
import { getDb } from "../db/client";
import {
  domains as domainsTable,
  projects as projectsTable,
  projectBuild as projectBuildTable,
  projectBuildMethodSettings as projectBuildMethodSettingsTable,
  projectExposes as projectExposesTable,
  projectMounts as projectMountsTable,
  projectVolumes as projectVolumesTable,
  sharedEnvGroupProjects,
  teamProjectOrder,
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
  FrameworkId,
  GitRepo,
  Project,
  ProjectStatus,
  UploadArchive,
  VolumeMount,
} from "../types";
import { usesComposeStack } from "../utils";
import {
  startDeployment,
  stopContainer,
  startContainer,
} from "../deploy/build";
import { ensureAutoDomain } from "./domains";
import {
  resolveServerIp,
  instanceHost,
  rehostSslip,
  rehostBlueprintHosts,
  sslipEmbeddedIp,
} from "../deploy/domains";
import { teardownProject } from "./deployments";
import { agentTeardownDev } from "../deploy/agent-dev";
import { removeUploads } from "../deploy/upload";
import { removeProjectDevSshUsers } from "./dev-ssh";
import { isValidLogoValue } from "../projects/logo-shared";
import { publishProjectChanged } from "../graphql/pubsub";
import {
  insertEnvVars,
  loadDomainsForProject,
  loadProjectGraph,
  loadProjectGraphBySlug,
  loadProjectsByIds,
  loadProjectsByTeam,
  preloadSummaries,
  projectInTeam,
  type SummaryPreload,
} from "./project-graph-load";
import {
  buildToRow,
  exposesToRows,
  methodSettingsToRow,
  mountsToRows,
  projectToRow,
  volumesToRows,
} from "./project-graph-rows";

/** Heuristic: treat secret-looking keys as masked secrets. */
function isSecretKey(key: string): boolean {
  return /pass|secret|token|key|api|private|credential|dsn|url/i.test(key);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ProjectSummary extends Project {
  latestDeployment: Deployment | null;
  domainCount: number;
}

// The pure read-time normalizers (`deriveVolumeName`/`normalizeVolumes`/
// `normalizeProject`) moved to `./normalize-project` so the project-graph backfill
// can apply the IDENTICAL normalization before exploding a legacy row into the
// strict child tables (relational-store PLAN §7). Re-exported here so this file's
// internal call sites — and the test that imports `deriveVolumeName` — are
// unchanged.
import {
  deriveVolumeName,
  normalizeProject,
  normalizeVolumes,
} from "./normalize-project";

export { deriveVolumeName };

/**
 * "stopping" is a transient state held only while `stopProject` awaits the
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
  status: ProjectStatus,
  updatedAt: string,
  now: number = Date.now(),
): ProjectStatus {
  if (status !== "stopping") return status;
  const age = now - new Date(updatedAt).getTime();
  return age > STOPPING_STALE_MS ? "idle" : "stopping";
}

/**
 * Fold a (relational, already-normalized) project into a {@link ProjectSummary}
 * — a PURE function over preloaded latest-deployment + domain-count maps (PLAN §6
 * "`summarize` becomes a pure function over preloaded data"). No DB access, so a
 * list of N projects costs the bounded batch-load below, not N×(deployment +
 * domain) round-trips. `reconcileStatus` still self-heals a wedged "stopping".
 */
function summarize(p: Project, pre: SummaryPreload): ProjectSummary {
  const status = reconcileStatus(p.status, p.updatedAt);
  return {
    ...p,
    status,
    // Projects created before the logo field have it absent; surface an explicit
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
 * Update a team-owned project's flat columns, throwing "Project not found" when
 * the id doesn't belong to the team (the standard ownership gate, now a single
 * team-scoped UPDATE … RETURNING instead of a find-then-mutate).
 */
async function updateProjectOwned(
  id: string,
  teamId: string,
  set: Partial<typeof projectsTable.$inferInsert>,
): Promise<void> {
  const updated = await getDb()
    .update(projectsTable)
    .set(set)
    .where(and(eq(projectsTable.id, id), eq(projectsTable.teamId, teamId)))
    .returning({ id: projectsTable.id });
  if (updated.length === 0) throw new Error("Project not found");
}

/** Team-wide manual project order (the `team_project_order` junction), id→rank. */
async function projectOrderRank(teamId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ projectId: teamProjectOrder.projectId, position: teamProjectOrder.position })
    .from(teamProjectOrder)
    .where(eq(teamProjectOrder.teamId, teamId));
  return new Map(rows.map((r) => [r.projectId, r.position] as const));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const teamId = await requireActiveTeamId();
  const [proj, rank] = await Promise.all([
    loadProjectsByTeam(teamId),
    projectOrderRank(teamId),
  ]);
  const pre = await preloadSummaries(proj);
  // Honour the team's manual order (Overview drag-and-drop) when present:
  // explicitly-ordered projects come first in that order, anything not listed
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
 * Persist the team-wide order of projects shown in the Overview grid. Team-wide
 * by design — every member sees the same arrangement — so it is gated like a
 * team setting: an instance admin (who bypasses team capabilities) or a member
 * holding `manage_team`. The incoming ids are sanitised to the caller's own team
 * projects (dropping unknown/duplicate ids); the `team_project_order` junction is
 * rewritten over the survivors. Any team project the client omitted is appended,
 * so the stored order stays total — and a dead id can no longer be stored at all
 * (the FK CASCADE makes the self-healing a DB invariant, PLAN §1).
 */
export async function reorderProjects(orderedIds: string[]): Promise<void> {
  const teamId = await requireActiveTeamId();
  // Instance admins bypass team capabilities; everyone else needs manage_team.
  if (!(await isInstanceAdmin())) {
    await requireCapability("manage_team");
  }
  await getDb().transaction(async (tx) => {
    const teamProjectIds = (
      await tx
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(eq(projectsTable.teamId, teamId))
    ).map((r) => r.id);
    const valid = new Set(teamProjectIds);
    const seen = new Set<string>();
    const next: string[] = [];
    for (const id of orderedIds) {
      if (valid.has(id) && !seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    }
    for (const id of teamProjectIds) if (!seen.has(id)) next.push(id);
    // Whole-set replace: drop the team's order rows, re-insert in the new order.
    await tx.delete(teamProjectOrder).where(eq(teamProjectOrder.teamId, teamId));
    if (next.length > 0) {
      await tx.insert(teamProjectOrder).values(
        next.map((projectId, position) => ({ teamId, projectId, position })),
      );
    }
  });
}

/** Summarize a single already-loaded project (its own bounded preload). */
async function summarizeOne(p: Project): Promise<ProjectSummary> {
  const pre = await preloadSummaries([p]);
  return summarize(p, pre);
}

export async function getProjectBySlug(
  slug: string
): Promise<ProjectSummary | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadProjectGraphBySlug(slug);
  return p && p.teamId === teamId ? summarizeOne(p) : null;
}

export async function getProjectById(id: string): Promise<Project | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadProjectGraph(id);
  return p && p.teamId === teamId ? p : null;
}

/**
 * Project summary by id for an already-resolved team, WITHOUT reading the
 * request's cookies. The live `projectStatus` subscription resolves the caller's
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
): Promise<ProjectSummary | null> {
  const p = await loadProjectGraph(id);
  return p && p.teamId === teamId ? summarizeOne(p) : null;
}

/** Cookie-free slug → summary lookup scoped to an explicit team (see above). */
export async function findProjectSummaryBySlugForTeam(
  slug: string,
  teamId: string,
): Promise<ProjectSummary | null> {
  const p = await loadProjectGraphBySlug(slug);
  return p && p.teamId === teamId ? summarizeOne(p) : null;
}

export interface CreateProjectInput {
  name: string;
  framework: FrameworkId;
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
  /** Compose/template deploys: which service + port Traefik exposes. */
  composeService?: string | null;
  composePort?: number | null;
  /** Every publicly-routed service in the stack (each with its own host). */
  exposes?: { service: string; port: number; host?: string }[] | null;
  /** Pre-generated domain a template baked into its env; kept consistent. */
  autoDomain?: string | null;
  /** Template config files to materialise at deploy time. */
  mounts?: { filePath: string; content: string }[] | null;
}

export async function createProject(
  input: CreateProjectInput
): Promise<ProjectSummary> {
  const { membership } = await requireCapability("deploy");
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
  // slug is globally UNIQUE in the relational table; pick the first free suffix.
  const existing = new Set(
    (await getDb().select({ slug: projectsTable.slug }).from(projectsTable)).map(
      (r) => r.slug,
    ),
  );
  let slug = slugBase || `project-${newId("").slice(1, 6)}`;
  let i = 1;
  while (existing.has(slug)) slug = `${slugBase}-${i++}`;

  // Servers are still JSONB-authoritative (no cut-set migrated them); their
  // relational rows are mirrored by `ensureServerRow` so a project's `server_id`
  // FK resolves. Read the picklist from the JSONB store (the source of truth).
  const servers = read().servers;
  // Default to the first server added; honour an explicit, existing pick. With no
  // server seeded at setup, the list can be empty — surface a clear error so the
  // operator adds (and provisions) a host first.
  const server =
    (input.serverId && servers.find((s) => s.id === input.serverId)) ||
    servers[0];
  if (!server)
    throw new Error(
      "No server available — add a server from Settings → Servers and run its install command first.",
    );

  // A template's generated sslip.io hosts (the primary autoDomain + every
  // exposes[].host, and any env value that embedded ${domain}) are baked in the
  // /new page against the instance IP (instanceHost), because the server isn't
  // known until submit. If this project targets a DIFFERENT server, those hosts
  // would route to (and display) the wrong IP — re-host them onto the target
  // server's IP. A no-op when the target IP matches and for non-sslip hosts.
  // resolveServerIp falls back to instanceHost for a server with no known IP yet,
  // so that case also no-ops rather than rehosting toward a bad address.
  const serverIp = resolveServerIp(server);
  const hosts = rehostBlueprintHosts(
    { autoDomain: input.autoDomain, exposes: input.exposes, env: input.env },
    instanceHost(),
    serverIp,
  );
  input.autoDomain = hosts.autoDomain;
  input.exposes = hosts.exposes;
  input.env = hosts.env;

  // An "upload" project has no archive at creation (it is uploaded from the
  // Settings page afterward, which triggers its own deploy via the upload route).
  // Deploying now would fail with "Nothing to deploy", so it is born idle instead
  // of queued; everything else starts queued and deploys below.
  const isUpload = input.source === "upload";

  const project: Project = {
    id: newId("prj"),
    name: input.name.trim(),
    slug,
    teamId: membership.teamId,
    // New projects start ungrouped (top level); a folder is assigned later from
    // the Overview (drag-into-folder or the card's "Move to folder" menu).
    folderId: null,
    serverId: server.id,
    framework: input.framework,
    // Defaulted from a template's logo (a /templates path); ignore anything that
    // isn't a valid inline logo so a crafted create payload can't store a URL.
    logo: input.logo && isValidLogoValue(input.logo) ? input.logo : null,
    source: input.source,
    repo: input.repo,
    dockerImage: input.dockerImage ?? null,
    upload: null,
    compose: input.compose ?? null,
    expose:
      input.composeService && input.composePort
        ? { service: input.composeService, port: input.composePort }
        : null,
    exposes: input.exposes?.length ? input.exposes : null,
    mounts: input.mounts?.length ? input.mounts : null,
    build: buildConfigFor(input.framework, input.build),
    dev: null,
    productionUrl: null,
    status: isUpload ? "idle" : "queued",
    autoDeploy: input.autoDeploy ?? true,
    latestDeploymentId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  // Initial environment variables (e.g. a template's defaults), encrypted at rest.
  const now = nowIso();
  const projectEnvVars: EnvVar[] = (input.env ?? [])
    .filter((e) => e.key.trim())
    .map((e) => ({
      id: newId("env"),
      projectId: project.id,
      key: e.key.trim(),
      valueEnc: encryptSecret(e.value),
      targets: ["production", "preview", "development"] as EnvTarget[],
      type: isSecretKey(e.key) ? ("secret" as const) : ("plain" as const),
      createdAt: now,
      updatedAt: now,
    }));

  // One transaction: the project + its FK-coupled children (build,
  // method-settings, exposes, mounts) + initial env (PLAN cut-set (c) Decision 15).
  // The domain + deploy fire AFTER commit so a failed insert leaves no orphan
  // auto-domain and no deploy job for a project that didn't persist.
  await getDb().transaction(async (tx) => {
    await tx.insert(projectsTable).values(projectToRow(project));
    await tx.insert(projectBuildTable).values(buildToRow(project.id, project.build));
    await tx
      .insert(projectBuildMethodSettingsTable)
      .values(methodSettingsToRow(project.id, project.build.methodSettings));
    const exposeRows = exposesToRows(project.id, project.exposes);
    if (exposeRows.length > 0) await tx.insert(projectExposesTable).values(exposeRows);
    const mountRows = mountsToRows(project.id, project.mounts);
    if (mountRows.length > 0) await tx.insert(projectMountsTable).values(mountRows);
    if (projectEnvVars.length > 0) await insertEnvVars(tx, projectEnvVars);
  });
  recordActivity("project", `Created project ${project.name}`, user.name, project.id);

  // POST-COMMIT (PLAN cut-set (c) "post-commit deploy"): register the generated
  // sslip.io domain so it shows up in the Domains section immediately and the
  // deploy routes to the same hostname a template baked into its env.
  const ip = resolveServerIp(server);
  await ensureAutoDomain(project.id, {
    slug,
    ip,
    preferred: input.autoDomain ?? undefined,
    // The primary host routes to the compose default expose (service + port) or,
    // for a single-image project, to build.port. `expose` is the first of
    // `exposes`, so it is the canonical default for the primary domain.
    defaultPort: project.expose?.port ?? project.build.port,
    defaultService: project.expose?.service ?? null,
  });

  if (!isUpload) {
    // Kick off the first real build + deploy. Runs in the background and flips
    // the project to active (or error) once the container is up.
    await startDeployment(project.id, {
      environment: "production",
      creator: user.name,
      commitMessage: input.repo ? "Initial import" : "Initial deployment",
    });
  }

  return summarizeOne((await loadProjectGraph(project.id))!);
}

export async function updateProjectBuild(
  id: string,
  build: Partial<BuildConfig>
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  // build.port is only WHICH container port Traefik routes to (routing), not a
  // published host port, so changing it isn't gated behind the expose-ports
  // grant — any member who can deploy may edit build settings.
  const user = (await getCurrentUser())!;
  // One tx (PLAN cut-set (c) Decision 15): the parent `project_build` columns
  // MERGE field-by-field, while a provided `methodSettings` object FULLY REPLACES
  // the 1-to-1 method-settings row.
  await getDb().transaction(async (tx) => {
    const existing = await loadProjectGraph(id, tx);
    if (!existing || existing.teamId !== membership.teamId)
      throw new Error("Project not found");
    const merged: BuildConfig = {
      ...existing.build,
      ...build,
      // methodSettings replaces wholesale when provided, else keep the existing.
      methodSettings: build.methodSettings ?? existing.build.methodSettings,
    };
    await tx
      .update(projectsTable)
      .set({ framework: build.framework ?? existing.framework, updatedAt: nowIso() })
      .where(eq(projectsTable.id, id));
    await tx
      .update(projectBuildTable)
      .set(buildToRow(id, merged))
      .where(eq(projectBuildTable.projectId, id));
    if (build.methodSettings) {
      // Whole-row replace of the method settings.
      await tx
        .update(projectBuildMethodSettingsTable)
        .set(methodSettingsToRow(id, merged.methodSettings))
        .where(eq(projectBuildMethodSettingsTable.projectId, id));
    }
  });
  recordActivity("project", `Updated build settings`, user.name, id);
}

export interface UpdateSourceInput {
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  serverId?: string;
  /** Compose YAML to persist (source === "compose"). Kept when switching away. */
  compose?: string | null;
  /** Which service + port Traefik exposes for the compose stack. */
  expose?: { service: string; port: number } | null;
  /** Every publicly-routed service in the stack (multi-domain templates). */
  exposes?: { service: string; port: number; host?: string }[] | null;
}

export async function updateProjectSource(
  id: string,
  input: UpdateSourceInput
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  // Saving compose YAML that publishes ports (`ports:`/`expose:`) requires the
  // expose-ports grant. Routing metadata (`expose`/`exposes` — Traefik domains)
  // is NOT port publishing and is intentionally not gated here.
  if (input.compose != null && composePublishesPorts(input.compose)) {
    await requireExposePorts();
  }
  // Saving compose YAML that bind-mounts a host path requires the host grant.
  if (input.compose != null && composeHasHostBindMount(input.compose)) {
    await requireMountHostVolumes();
  }
  const user = (await getCurrentUser())!;
  const serversById = new Map(read().servers.map((s) => [s.id, s] as const));
  await getDb().transaction(async (tx) => {
    const p = await loadProjectGraph(id, tx);
    if (!p || p.teamId !== membership.teamId) throw new Error("Project not found");
    // Capture the OLD server IP before serverId is reassigned, so a move can
    // re-host the project's auto sslip.io domains onto the new server's IP below.
    const oldIp = resolveServerIp(serversById.get(p.serverId));
    let serverId = p.serverId;
    if (input.serverId) {
      if (!serversById.has(input.serverId)) throw new Error("Server not found");
      serverId = input.serverId;
    }
    // `expose` is derived as `exposes[0]`, never stored; an explicit `expose`
    // input with no `exposes` becomes the single exposes entry.
    let exposes: Project["exposes"] =
      input.exposes !== undefined
        ? input.exposes
        : input.expose !== undefined
          ? input.expose
            ? [input.expose]
            : null
          : p.exposes;

    // MOVING the project to a different server: its auto sslip.io hosts encode
    // the OLD server's IP, so re-host them onto the new server's IP — otherwise
    // the Domains section (and Traefik's routing target) keeps pointing at the
    // old host. Covers the primary + every extra (web-ui.*) auto domain and the
    // stored exposes[].host. Applied AFTER exposes lands so the final stored value
    // is rehosted. A no-op when the IP is unchanged or the host isn't sslip.
    const newIp = resolveServerIp(serversById.get(serverId));
    if (newIp !== oldIp) {
      // Rehost the project's auto sslip.io domain rows in place.
      const projectDomains = await loadDomainsForProject(p.id, tx);
      for (const dom of projectDomains) {
        if (dom.source === "auto" && sslipEmbeddedIp(dom.name) === oldIp) {
          await tx
            .update(domainsTable)
            .set({ name: rehostSslip(dom.name, newIp) })
            .where(eq(domainsTable.id, dom.id));
        }
      }
      if (exposes?.length) {
        exposes = exposes.map((e) =>
          e.host && sslipEmbeddedIp(e.host) === oldIp
            ? { ...e, host: rehostSslip(e.host, newIp) }
            : e,
        );
      }
    }

    await tx
      .update(projectsTable)
      .set({
        serverId,
        source: input.source,
        repoProvider: input.repo?.provider ?? null,
        repoUrl: input.repo?.url ?? null,
        repoRepo: input.repo?.repo ?? null,
        repoBranch: input.repo?.branch ?? null,
        repoInstallationId: input.repo?.installationId ?? null,
        dockerImage: input.dockerImage,
        // Persist compose edits when provided; never clear a stored stack on
        // switch so the user can flip back to Compose and recover it.
        ...(input.compose != null ? { compose: input.compose } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(projectsTable.id, id));

    // Replace the ordered exposes child rows when the input changed them.
    if (input.exposes !== undefined || input.expose !== undefined) {
      await tx.delete(projectExposesTable).where(eq(projectExposesTable.projectId, id));
      const rows = exposesToRows(id, exposes);
      if (rows.length > 0) await tx.insert(projectExposesTable).values(rows);
    }
  });
  recordActivity("project", `Updated deploy source`, user.name, id);
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
 * (setProjectVolumes), not here, so this stays a pure validator usable in tests.
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

    if (v.type === "project") {
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
          `Project path must be relative to the project's files dir, e.g. "config.toml": "${v.projectPath}"`,
        );
      }
      if (/[\s:]/.test(projectPath)) {
        throw new Error(
          `Project path must not contain spaces or ":": "${v.projectPath}"`,
        );
      }
      if (projectPath.split("/").includes("..")) {
        throw new Error(`Project path must not contain "..": "${v.projectPath}"`);
      }
      out.push({
        id: v.id || newId("vol"),
        type: "project",
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
 * projects — they declare volumes inside their own YAML. An empty set is stored
 * as null so renderCompose stays byte-identical. Persists only; the new mounts
 * take effect on the next production deploy (consistent with the other per-card
 * settings mutations).
 */
export async function setProjectVolumes(
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
    const p = await loadProjectGraph(id, tx);
    if (!p || p.teamId !== membership.teamId) throw new Error("Project not found");
    if (usesComposeStack(p)) {
      throw new Error(
        "Volumes are managed inside the compose file for this project.",
      );
    }
    // Validate against the project's mounts (the conflict check), then whole-set
    // replace the `project_volumes` ordered child rows.
    const validated = validateVolumes(volumes, p.mounts);
    await tx.delete(projectVolumesTable).where(eq(projectVolumesTable.projectId, id));
    const rows = volumesToRows(id, validated);
    if (rows.length > 0) await tx.insert(projectVolumesTable).values(rows);
    await tx
      .update(projectsTable)
      .set({ updatedAt: nowIso() })
      .where(eq(projectsTable.id, id));
  });
  recordActivity("project", `Updated volumes`, user.name, id);
}

/**
 * Point a project at a freshly uploaded archive and switch its source to
 * "upload". Called by the upload route handler after the file is on disk; the
 * route then triggers a deploy that extracts and builds it. Forgets any repo /
 * docker image so the deploy pipeline takes the upload branch unambiguously.
 */
export async function setProjectUpload(
  id: string,
  upload: UploadArchive,
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  await updateProjectOwned(id, membership.teamId, {
    source: "upload",
    uploadId: upload.id,
    uploadFilename: upload.filename,
    uploadPath: upload.path,
    uploadSize: upload.size,
    uploadUploadedAt: upload.uploadedAt,
    // Forget any repo / docker image so the deploy takes the upload branch.
    repoProvider: null,
    repoUrl: null,
    repoRepo: null,
    repoBranch: null,
    repoInstallationId: null,
    dockerImage: null,
    updatedAt: nowIso(),
  });
  recordActivity("project", `Uploaded ${upload.filename}`, user.name, id);
}

export async function setAutoDeploy(id: string, value: boolean): Promise<void> {
  const { membership } = await requireCapability("deploy");
  await updateProjectOwned(id, membership.teamId, {
    autoDeploy: value,
    updatedAt: nowIso(),
  });
}

export async function renameProject(id: string, name: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  await updateProjectOwned(id, membership.teamId, {
    name: name.trim(),
    updatedAt: nowIso(),
  });
  recordActivity("project", `Renamed project to ${name}`, user.name, id);
}

/**
 * Set (or clear) the project's display logo. An empty value clears it, falling
 * the UI back to the framework icon. The logo is stored INLINE on the project
 * as a base64 image data-URI (uploaded image) or a local /templates path
 * (template default) — never a remote URL, so it renders under the strict CSP
 * with no cross-origin fetch (see {@link isValidLogoValue}). Purely cosmetic:
 * it never touches the deploy source or the Docker image the stack runs.
 *
 * No-op (no updatedAt bump, no activity record) when the value is unchanged, so
 * an idle Save doesn't reorder the dashboard or write a spurious log line.
 */
export async function updateProjectLogo(
  id: string,
  logo: string | null,
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const next = logo?.trim() ? logo.trim() : null;
  if (next && !isValidLogoValue(next)) {
    throw new Error("Unsupported logo image");
  }
  // No-op (no updatedAt bump, no activity) when unchanged: only update rows whose
  // logo actually differs (a team-scoped conditional UPDATE … RETURNING).
  const updated = await getDb()
    .update(projectsTable)
    .set({ logo: next, updatedAt: nowIso() })
    .where(
      and(
        eq(projectsTable.id, id),
        eq(projectsTable.teamId, membership.teamId),
        next === null
          ? sql`${projectsTable.logo} is not null`
          : sql`${projectsTable.logo} is distinct from ${next}`,
      ),
    )
    .returning({ id: projectsTable.id });
  // Distinguish "not found / not owned" from "unchanged": a found-but-unchanged
  // row simply skips the activity below. Verify existence only when nothing changed.
  if (updated.length === 0) {
    const exists = await projectInTeam(id, membership.teamId);
    if (!exists) throw new Error("Project not found");
    return;
  }
  recordActivity("project", `Updated project logo`, user.name, id);
}

/** Set a project's status and notify every live subscriber. */
async function setProjectStatus(id: string, status: ProjectStatus): Promise<void> {
  await getDb()
    .update(projectsTable)
    .set({ status, updatedAt: nowIso() })
    .where(eq(projectsTable.id, id));
  publishProjectChanged(id);
}

/** Stop the project's running container. */
export async function stopProject(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const project = await loadProjectGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("Project not found");
  // Persist "stopping" BEFORE the (up to 60s) container stop so the transition
  // is visible to every client immediately and survives a reload — not just a
  // local label on the clicking user's button. We settle to "idle" once the
  // stop returns (success or failure: the intent was to stop).
  await setProjectStatus(id, "stopping");
  recordActivity("project", `Stopping ${project.name}`, user.name, id);
  try {
    await stopContainer(project.slug);
  } catch (e) {
    // A stop failure must FAIL CLEARLY (PLAN Part C): the container may still be
    // running on the host, so settling to "idle" would lie. This covers BOTH an
    // unreachable agent (AgentUnreachableError) AND a reachable agent that
    // reported the stop failed (build.ts throws a plain Error on ok:false).
    await setProjectStatus(id, "active");
    throw new Error(
      `The stack on ${project.name}'s server was not stopped: ${errMsg(e)}`,
    );
  }
  await setProjectStatus(id, "idle");
}

/** Start a previously stopped project's container. */
export async function startProject(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const project = await loadProjectGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("Project not found");
  try {
    await startContainer(project.slug);
  } catch (e) {
    // Start failure (unreachable, or agent reported start failed): fail clearly
    // rather than marking it "active" falsely.
    throw new Error(
      `The stack on ${project.name}'s server was not started: ${errMsg(e)}`,
    );
  }
  await setProjectStatus(id, "active");
  recordActivity("project", `Started ${project.name}`, user.name, id);
}

/** Rebuild the image from the current source and redeploy (real build). */
export async function rebuildProject(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  if (!(await projectInTeam(id, membership.teamId)))
    throw new Error("Project not found");
  await startDeployment(id, {
    environment: "production",
    creator: user.name,
    commitMessage: "Rebuild container",
  });
}

export async function deleteProject(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const project = await loadProjectGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("Project not found");
  // Tear down the running container/stack before dropping the records. A REMOTE
  // whose agent is unreachable can't be torn down now — proceed with the delete
  // anyway (P6 spirit: never leave records pinned to a dead box) and warn so the
  // operator cleans up the leftover containers by hand. The agent calls run
  // OUTSIDE any DB transaction (PLAN §1 rule (a): never wrap a gRPC dial in a tx).
  const tornDown = await teardownProject(project.slug);
  const server = read().servers.find((s) => s.id === project.serverId);
  if (!tornDown && server) {
    recordActivity(
      "project",
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
  await removeProjectDevSshUsers(id).catch(() => {});
  // Drop any uploaded archive backing an "upload" source.
  await removeUploads(id).catch(() => {});
  // One DELETE — the FK CASCADEs do the rest: deployments (+ logs), env_vars
  // (+ targets), domains (+ middlewares), the 6 project child tables, the
  // team_project_order rows, AND shared_env_group_projects (the orphan the old
  // JSONB deleteProject leaked is now impossible — PLAN §7 "the live cascade is
  // fixed in cut-set (c)"). backups.project_id is SET NULL (history outlives the
  // project), so no project-target backup is orphaned either.
  await getDb().delete(projectsTable).where(eq(projectsTable.id, id));
  recordActivity("project", `Deleted project ${project.name}`, user.name, null);
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/**
 * Bulk-delete several projects. Tears down each project's stack with BOUNDED
 * concurrency (so a large multi-select can't flood one server's agent with
 * simultaneous teardowns), then removes ALL their records in a SINGLE store write
 * — one document persist + one activity row, instead of N independent
 * `deleteProject` round-trips. Team-scoped; unknown/foreign ids are ignored.
 * Returns the number actually deleted.
 */
export async function deleteProjects(ids: string[]): Promise<number> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const idSet = [...new Set(ids)];
  // Team-scoped: only the caller's own projects, fully loaded for teardown.
  const projects = (await loadProjectsByIds(idSet)).filter(
    (p) => p.teamId === membership.teamId,
  );
  if (projects.length === 0) return 0;

  const serversById = new Map(read().servers.map((s) => [s.id, s] as const));
  // Tear down stacks ≤4 at a time (agent calls OUTSIDE any tx). A throw/
  // unreachable for one project must not abort the others or the record removal.
  const unreachable: string[] = [];
  await mapLimit(projects, 4, async (project) => {
    const tornDown = await teardownProject(project.slug).catch(() => false);
    if (!tornDown) {
      const server = serversById.get(project.serverId);
      if (server) unreachable.push(`${project.name} (${server.name})`);
    }
    await agentTeardownDev(project).catch(() => {});
    await removeProjectDevSshUsers(project.id).catch(() => {});
    await removeUploads(project.id).catch(() => {});
  });

  // One DELETE — FK CASCADEs remove every child + the shared-group attachments
  // (no orphan); backups.project_id SET NULL keeps history.
  const gone = projects.map((p) => p.id);
  await getDb().delete(projectsTable).where(inArray(projectsTable.id, gone));
  recordActivity(
    "project",
    `Deleted ${projects.length} project${projects.length === 1 ? "" : "s"}`,
    user.name,
    null,
  );
  if (unreachable.length) {
    recordActivity(
      "project",
      `Some servers were unreachable during bulk delete — leftover containers may ` +
        `remain and must be removed manually: ${unreachable.join(", ")}`,
      user.name,
      null,
    );
  }
  return projects.length;
}
