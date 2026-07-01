import "server-only";

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { and, eq, inArray } from "drizzle-orm";
import { getServerById } from "../data/servers";
import { getDb } from "../db/client";
import {
  deployments as deploymentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { decryptSecret } from "../crypto";
import { resolveEnvEntries } from "./env-resolve";
import { loadGlobalEnvForProject } from "../data/global-env";
import { recordActivity } from "../data/activity";
import {
  loadDeployment,
  loadDomainsForProject,
  loadProjectGraph,
  loadProjectGraphBySlug,
  loadEnvVarsForProject,
  loadSharedEnvGroupsForProject,
} from "../data/project-graph-load";
import {
  appendLog,
  clearDeploymentLogs,
  finalizeDeploymentLogs,
} from "../data/deployment-logs";
import { deploymentToRow } from "../data/project-graph-rows";
import { ensureNetwork } from "../infra/docker";
import { buildImage } from "./builders";
import { extractArchive } from "./upload";
import {
  planDeploySource,
  resolveBuildDir,
  devWorkspaceDeployAllowed,
} from "./source";
import { normalizeBuildConfig } from "../frameworks";
import { usesComposeStack, hostVolumeName } from "../utils";
import { certResolver, previewDomain, resolveServerIp } from "./domains";
import { traefikRouterLabels } from "./routing";
import { buildComposeStack } from "./compose-stack";
import {
  primaryDomainName,
  routableRoutes,
  defaultRoute,
  type RoutableDomain,
} from "../data/domains";
import { basicAuthUsersValue } from "../data/basic-auth";
import { installationCloneUrl } from "../github/app";
import { publishProjectChanged } from "../graphql/pubsub";
import {
  agentCapabilityForMethod,
  runAgentDeploy,
  AgentUnavailableError,
  type AgentBuildPlan,
} from "./agent-deploy";
import { connectAgent, agentPreflight } from "../infra/agent-client";
import type { Deployment, DeploymentEnvironment, LogLine } from "../types";

/**
 * The owning server id for a slug's project — its lifecycle verbs run on that
 * server's agent (every project is agent-backed now, the host running Deplo
 * included). Null for an unknown slug / a project whose server row is missing.
 */
async function owningServerIdForSlug(slug: string): Promise<string | null> {
  const p = await loadProjectGraphBySlug(slug);
  if (!p) return null;
  // Servers stay JSONB-authoritative; confirm the owning server still exists.
  const server = await getServerById(p.serverId);
  return server ? server.id : null;
}

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const STACK_DIR = join(DATA_DIR, "stacks");

// Enqueue one build-log line. SYNCHRONOUS fire-and-forget into the buffered
// writer (PLAN §6 Decision 18) so it stays a `void` sink usable as a callback
// prop; the writer batches + flushes in the background.
function log(depId: string, level: LogLine["level"], text: string): void {
  appendLog(depId, { ts: nowIso(), level, text });
}

async function setDep(depId: string, patch: Partial<Deployment>): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.environment !== undefined) set.environment = patch.environment;
  if (patch.commitSha !== undefined) set.commitSha = patch.commitSha;
  if (patch.commitMessage !== undefined) set.commitMessage = patch.commitMessage;
  if (patch.commitAuthor !== undefined) set.commitAuthor = patch.commitAuthor;
  if (patch.branch !== undefined) set.branch = patch.branch;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.readyAt !== undefined) set.readyAt = patch.readyAt;
  if (patch.buildDurationMs !== undefined)
    set.buildDurationMs = patch.buildDurationMs;
  const rows = await getDb()
    .update(deploymentsTable)
    .set(set)
    .where(eq(deploymentsTable.id, depId))
    .returning({ projectId: deploymentsTable.projectId });
  // A deployment's status feeds the project's `latestDeployment` view, so push
  // the owning project to live subscribers when it changes.
  const projectId = rows[0]?.projectId;
  if (projectId && "status" in patch) publishProjectChanged(projectId);
}

async function setProject(
  projectId: string,
  patch: Partial<typeof projectsTable.$inferInsert>,
): Promise<void> {
  await getDb()
    .update(projectsTable)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(projectsTable.id, projectId));
  publishProjectChanged(projectId);
}

/**
 * Decrypted env for the production stack: per-project vars targeting
 * `production`, plus attached shared groups that also target `production`.
 * Selection lives in the shared `resolveEnvEntries` seam; we only decrypt here.
 */
async function projectEnv(projectId: string): Promise<Record<string, string>> {
  const [vars, groups, globals] = await Promise.all([
    loadEnvVarsForProject(projectId),
    loadSharedEnvGroupsForProject(projectId),
    loadGlobalEnvForProject(projectId),
  ]);
  const out: Record<string, string> = {};
  for (const e of resolveEnvEntries(
    "production",
    projectId,
    vars,
    groups,
    globals.teamGlobals,
    globals.instanceGlobals,
  )) {
    out[e.key] = decryptSecret(e.valueEnc);
  }
  return out;
}

/**
 * The NAMES of the env vars a production deploy resolves for a project — exactly
 * the keys `projectEnv` would carry (same selection seam), but WITHOUT decrypting
 * any value. These are injected into a compose stack's `environment:` as bare
 * `- KEY` pass-throughs (`buildComposeStack`'s `envKeys`): a settings var reaches
 * the containers without the user hand-writing it, while the VALUE still rides
 * the `--env-file`. Deriving the keys from the same resolver guarantees we only
 * ever inject a key the env-file actually supplies (globals + shared groups
 * included), so an injected pass-through can never reference an undefined var.
 */
async function projectEnvKeys(projectId: string): Promise<string[]> {
  const [vars, groups, globals] = await Promise.all([
    loadEnvVarsForProject(projectId),
    loadSharedEnvGroupsForProject(projectId),
    loadGlobalEnvForProject(projectId),
  ]);
  // De-dupe on key (the resolver emits lowest-precedence first; a later entry
  // wins on value, but for NAMES we just need the distinct set).
  const seen = new Set<string>();
  for (const e of resolveEnvEntries(
    "production",
    projectId,
    vars,
    groups,
    globals.teamGlobals,
    globals.instanceGlobals,
  )) {
    seen.add(e.key);
  }
  return [...seen];
}

// Exported for unit tests (render byte-identical contract + the volume YAML
// shape). Pure: no docker, store, or fs access.
export function renderCompose(opts: {
  name: string;
  image: string;
  port: number;
  projectId: string;
  slug: string;
  /** Public hostnames + per-domain port overrides, primary first. */
  routes: RoutableDomain[];
  env: Record<string, string>;
  /**
   * User-managed volumes. A "named" volume (default) gets a top-level `volumes:`
   * entry whose host name is namespaced per-project via `hostVolumeName`; a
   * "project" bind renders its `projectPath` resolved against the project's
   * isolated files dir; a "host" bind mount renders its `hostPath` directly as
   * the source. Only NAMED volumes get a top-level entry — "project" and "host"
   * are bind mounts (absolute source) and get none. Empty/absent (and no NAMED
   * volumes) ⇒ NO `volumes:` keys are emitted, keeping the output byte-identical
   * to the long-standing stack so a reroute of an unchanged routing set never
   * restarts the container.
   */
  volumes?: {
    type?: "named" | "project" | "host";
    name: string;
    projectPath?: string;
    hostPath?: string;
    mountPath: string;
    readOnly?: boolean;
  }[];
  /**
   * Whether to inject `PORT=<port>` into the container env. True for sources
   * Deplo BUILDS (git/upload/dockerfile/dev-workspace) — 12-factor apps bind
   * to $PORT, so we tell the container where Traefik forwards. FALSE for a
   * prebuilt docker image: that image is deployed as-is and its author already
   * chose where it listens; injecting PORT silently overrides that listen
   * address (e.g. an image that binds :8080 gets forced onto :3000). The routing
   * target is unaffected — it comes from the Ports/Domains routing model
   * (`expose.port`/per-domain `route.port`), not from this env var.
   */
  injectPort?: boolean;
  /**
   * Project-wide HTTP Basic Auth htpasswd users (`user:$apr1$…,user2:…`, raw
   * single-`$`). When non-empty, a generated `basicauth` middleware is defined
   * and prepended to every router's chain so ALL hostnames are gated. Empty/
   * absent ⇒ no middleware (byte-identical to a project without basic auth). The
   * `$`→`$$` compose escaping happens inside the router grammar.
   */
  basicAuthUsers?: string;
}): string {
  const { name, image, port, projectId, slug, routes } = opts;
  const injectPort = opts.injectPort ?? true;
  const vols = opts.volumes ?? [];
  const namedVols = vols.filter((v) => v.type !== "host" && v.type !== "project");
  // Absolute, per-project files dir — the same sandbox the `./<x>` compose
  // convention resolves to. A "project" mount's source is rendered here so it
  // stays isolated (never resolved against the stack dir by docker).
  const filesDir = join(STACK_DIR, "files", slug);
  // Default PORT to the project's default container port so 12-factor apps
  // (buildpacks, Nixpacks, Railpack) bind where Traefik forwards. A user-set
  // PORT wins. Per-domain port overrides only change Traefik's target, not the
  // single PORT the container is told to listen on. Skipped entirely for a
  // prebuilt image (injectPort=false): it deploys as-is and owns its own listen
  // address — see the injectPort docs above.
  const env = injectPort ? { PORT: String(port), ...opts.env } : { ...opts.env };
  // Traefik routing (TLS via Let's Encrypt), one router per distinct target
  // port. The global web->websecure redirect is configured on the proxy, so no
  // per-router middleware is needed here.
  const labels = [
    // Single-image production flavour: per-port grouping under the bare baseKey,
    // the explicit `.service` label only when there's more than one router, and
    // no `traefik.docker.network` label (the stack joins only `deplo`). This is
    // the long-standing output — kept byte-identical so a reroute of an
    // unchanged routing set never restarts the container.
    ...traefikRouterLabels({
      baseKey: name,
      routes,
      defaultPort: port,
      certResolver: certResolver(),
      ...(opts.basicAuthUsers
        ? { basicAuth: { name: `${name}-basicauth`, users: opts.basicAuthUsers } }
        : {}),
    }),
    "deplo.managed=true",
    `deplo.project=${projectId}`,
    `deplo.slug=${slug}`,
  ];
  const labelsYaml = labels.map((l) => `      - "${l}"`).join("\n");
  const envYaml = Object.keys(env).length
    ? "    environment:\n" +
      Object.entries(env)
        .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
        .join("\n") +
      "\n"
    : "";
  // Two volume fragments, each exactly "" when there are no volumes so the
  // generated stack stays byte-identical to the no-volumes baseline (the reroute
  // contract). A NAMED volume's service source is its docker alias and also gets
  // a top-level entry pinning the per-project host name (namespaced so it can't
  // collide with another team's on the shared daemon); compose creates it on
  // first up and reuses it across redeploys. A HOST bind mount's source IS the
  // host path and gets NO top-level entry (docker treats a "/"-prefixed source
  // as a bind, not a named volume).
  const serviceVolsYaml = vols.length
    ? "    volumes:\n" +
      vols
        .map((v) => {
          const source =
            v.type === "host"
              ? v.hostPath
              : v.type === "project"
                ? `${filesDir}/${v.projectPath}`
                : v.name;
          return `      - ${source}:${v.mountPath}${v.readOnly ? ":ro" : ""}`;
        })
        .join("\n") +
      "\n"
    : "";
  const topVolsYaml = namedVols.length
    ? "\nvolumes:\n" +
      namedVols
        .map((v) => `  ${v.name}:\n    name: ${hostVolumeName(slug, v.name)}`)
        .join("\n") +
      "\n"
    : "";

  return `# Generated by Deplo  ${slug}
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    networks:
      - deplo
${envYaml}${serviceVolsYaml}    labels:
${labelsYaml}

networks:
  deplo:
    external: true
${topVolsYaml}`;
}


/** A deployment status that is non-terminal — a build was in flight. */
export function isInFlightStatus(s: Deployment["status"]): boolean {
  return s === "queued" || s === "building";
}

/**
 * Reconcile deployments orphaned by a control-plane restart (PLAN D5, Part-A
 * half). A deploy is fire-and-forget in Part A: its `runDeployment` job lives
 * only in the process that started it, so a restart mid-build leaves the row
 * stuck in `queued`/`building` forever with no job to finish it. On boot we mark
 * every such row `error` (and settle its project off `building`/`queued`),
 * cleanly, rather than letting a stale "building" lie indefinitely. Real
 * reconnection/replay — keeping the agent's build alive across a restart — is
 * Part B; Part A just refuses to leave a hung deploy that lies.
 *
 * Idempotent and safe to run once at startup. Returns the number reconciled.
 */
export async function reconcileInFlightDeployments(): Promise<number> {
  const db = getDb();
  // Find the orphaned in-flight deployments, mark them error, and append one
  // interrupted-log line each (through the buffered writer, finalized below).
  const inFlight = await db
    .select({ id: deploymentsTable.id, projectId: deploymentsTable.projectId })
    .from(deploymentsTable)
    .where(inArray(deploymentsTable.status, ["queued", "building"]));
  if (inFlight.length === 0) return 0;
  const affectedProjects = new Set(inFlight.map((d) => d.projectId));
  await db
    .update(deploymentsTable)
    .set({ status: "error" })
    .where(inArray(deploymentsTable.status, ["queued", "building"]));
  for (const dep of inFlight) {
    log(dep.id, "error", "Deployment interrupted by a control-plane restart and marked failed.");
  }
  await Promise.all(inFlight.map((d) => finalizeDeploymentLogs(d.id)));
  // A project left mid-deploy settles off the transient build state.
  await db
    .update(projectsTable)
    .set({ status: "error", updatedAt: nowIso() })
    .where(
      and(
        inArray(projectsTable.id, [...affectedProjects]),
        inArray(projectsTable.status, ["building", "queued"]),
      ),
    );
  for (const projectId of affectedProjects) publishProjectChanged(projectId);
  console.warn(
    `[deplo] reconciled ${inFlight.length} interrupted deployment(s) to error on startup`,
  );
  return inFlight.length;
}

/**
 * Create a deployment record (queued) and kick off the real build in the
 * background. Returns the deployment id immediately; the job updates status and
 * logs as it progresses.
 */
export async function startDeployment(
  projectId: string,
  opts: {
    environment?: DeploymentEnvironment;
    creator: string;
    commitMessage?: string;
    branch?: string;
    /** Build PRODUCTION from the dev workspace tree instead of the source. */
    buildSource?: "dev-workspace";
  },
): Promise<string> {
  const project = await loadProjectGraph(projectId);
  if (!project) throw new Error("Project not found");
  const server = (await getServerById(project.serverId)) ?? undefined;
  const ip = resolveServerIp(server);
  const environment = opts.environment ?? "production";
  const branch = opts.branch ?? project.repo?.branch ?? "main";
  // Production routes through the project's EXISTING registered primary domain
  // (created once at project creation). It is NOT resurrected here: a project
  // whose domains were all deleted deploys with NO domain and NO URL — the
  // container runs but is unrouted until the user adds a domain back. Previews
  // are ephemeral and always get their own host.
  const domain =
    environment === "production"
      ? await primaryDomainName(projectId)
      : previewDomain(project.slug, newId("").slice(1, 7), ip);
  // No production domain ⇒ no canonical URL. The deployment record's `url` is a
  // plain string (informational), so it carries "" when unrouted; the project's
  // `productionUrl` is nullable and gets a real null below.
  const url = domain ? `https://${domain}` : "";
  const depId = newId("dpl");

  const dep: Deployment = {
    id: depId,
    projectId,
    status: "queued",
    environment,
    commitSha: "",
    commitMessage: opts.commitMessage ?? "Deploy",
    commitAuthor: opts.creator,
    branch,
    url,
    createdAt: nowIso(),
    readyAt: null,
    buildDurationMs: null,
    creator: opts.creator,
    ...(opts.buildSource ? { buildSource: opts.buildSource } : {}),
  };

  // Insert the deployment, then point the project at it (latestDeployment +
  // queued). A fresh build starts from an empty log stream (drain-then-DELETE).
  await getDb().insert(deploymentsTable).values(deploymentToRow(dep));
  await clearDeploymentLogs(depId);
  await getDb()
    .update(projectsTable)
    .set({
      latestDeploymentId: depId,
      status: "queued",
      updatedAt: nowIso(),
      ...(environment === "production" ? { productionUrl: domain ? url : null } : {}),
    })
    .where(eq(projectsTable.id, projectId));
  await recordActivity("deployment", `Deploying ${project.name}`, opts.creator, projectId);
  // A new deployment flips the project to "queued" and sets latestDeployment —
  // push it to live subscribers so the header/tabs update without a reload.
  publishProjectChanged(projectId);

  // Fire-and-forget: the standalone Node server keeps the event loop alive.
  // runDeployment finalizes its own logs in a finally; this guards a throw from
  // its pre-try setup (e.g. ensureAutoDomain) and flushes that error line too.
  void runDeployment(depId).catch(async (e) => {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    await setDep(depId, { status: "error" });
    await finalizeDeploymentLogs(depId);
  });
  return depId;
}

/**
 * Build an image from a materialised source tree: resolve rootDirectory the one
 * shared way ({@link resolveBuildDir}) and dispatch to the selected build method.
 * The git / upload / dev-workspace arms all funnel through here, so the
 * rootDirectory containment + the buildImage call live in exactly one place.
 */
async function buildImageFromTree(opts: {
  depId: string;
  project: { id: string; build: Parameters<typeof normalizeBuildConfig>[0] };
  slug: string;
  workDir: string;
  root: string;
  imageRef: string;
  /** Hard-fail on an explicit-but-missing rootDirectory (git/dev); upload doesn't. */
  failOnMissing: boolean;
  notFoundMessage?: string;
  /**
   * When set, resolve rootDirectory but DO NOT build locally — the agent will
   * build from the returned `buildDir` instead (Part A: the build moves
   * agent-side). The rootDirectory containment still runs here, in one place.
   */
  skipBuild?: boolean;
}): Promise<{ buildDir: string }> {
  const { depId, project, slug, workDir, root, imageRef } = opts;
  const buildDir = await resolveBuildDir({
    root,
    rootDirectory: project.build.rootDirectory,
    failOnMissing: opts.failOnMissing,
    notFoundMessage: opts.notFoundMessage,
  });
  if (opts.skipBuild) return { buildDir };
  // Dispatch to the selected build method (Dockerfile / Nixpacks / Railpack /
  // Heroku|Paketo buildpacks / Static). Each produces imageRef in the local
  // store with the deplo.* labels, listening on build.port.
  await buildImage({
    build: normalizeBuildConfig(project.build),
    workDir,
    buildDir,
    slug,
    projectId: project.id,
    imageRef,
    log: (level, text) => log(depId, level, text),
  });
  return { buildDir };
}

/**
 * Render the single-image (or compose) stack and stream it through the OWNING
 * agent. Returns "agent" when the agent fully built + ran the deploy, "failed"
 * when it reported a build failure OR was unreachable — there is no in-process
 * fallback, so an unavailable agent is a hard deploy failure (P5), never a silent
 * local rebuild. This is the single choke point: every deploy flows agent →
 * control plane → pubsub.
 */
/** The agent attempt's outcome + any commit sha the agent resolved (git source). */
interface AgentAttempt {
  outcome: "agent" | "failed";
  commitSha: string;
}

async function tryAgent(opts: {
  depId: string;
  serverId: string;
  project: { id: string; slug: string };
  imageRef: string;
  composeYaml: string;
  env: Record<string, string>;
  plan: AgentBuildPlan;
  /** How long the agent waits for the stack to report running (ms). Defaults to
   * 60s (the single-image path); the compose path passes 90s since a multi-service
   * stack may pull several images first. */
  readyTimeoutMs?: number;
}): Promise<AgentAttempt> {
  try {
    const { ready, commitSha } = await runAgentDeploy({
      serverId: opts.serverId,
      deployId: opts.depId,
      slug: opts.project.slug,
      projectId: opts.project.id,
      imageRef: opts.imageRef,
      composeYaml: opts.composeYaml,
      env: opts.env,
      plan: opts.plan,
      readyTimeoutMs: opts.readyTimeoutMs ?? 60_000,
      sink: { log: (level, text) => log(opts.depId, level, text) },
    });
    return { outcome: ready ? "agent" : "failed", commitSha };
  } catch (e) {
    if (e instanceof AgentUnavailableError) {
      // No in-process build path to fall back to: surface the unreachable agent
      // as a clear deploy failure (P5 — no hung deploys).
      log(opts.depId, "error", `Agent unavailable: ${e.message}`);
      return { outcome: "failed", commitSha: "" };
    }
    throw e;
  }
}

async function runDeployment(depId: string): Promise<void> {
  const started = Date.now();
  const dep = await loadDeployment(depId);
  if (!dep) return;
  const project = await loadProjectGraph(dep.projectId);
  if (!project) {
    await setDep(depId, { status: "error" });
    return;
  }
  const slug = project.slug;
  const name = `deplo-${slug}`;
  // Production routes through the project's EXISTING registered primary domain
  // (never resurrected — see startDeployment). When the project has no domain,
  // `domain` is "" and the deploy proceeds UNROUTED (the build still runs; the
  // container just gets `traefik.enable=false`). A preview uses its ephemeral
  // host parsed back from the deployment URL.
  const domain =
    dep.environment === "production"
      ? await primaryDomainName(project.id)
      : dep.url.replace(/^https?:\/\//, "");
  // Production routes to every verified domain (primary first); a preview uses
  // only its ephemeral host (not a registered domain). Empty when the project
  // has no domain — the renderers emit no router (traefik.enable=false).
  const routeDomains = await routableForDeploy(project.id, dep.environment, domain);

  await setDep(depId, { status: "building" });
  await setProject(project.id, { status: "building" });

  try {
    await mkdir(STACK_DIR, { recursive: true });
    await ensureNetwork("deplo");

    // The agent now runs EVERY build method (Dockerfile family + the heavy
    // builders static/nixpacks/buildpacks/railpack, ported to deplo-agent). The
    // only gate left is per-server: is THIS server's agent new enough to carry the
    // method's capability? That check is below (after the compose branch), keyed on
    // agentCapabilityForMethod. A compose stack is NOT a single-image build — it
    // never consults project.build — so it is handled by its own branch first and
    // is exempt from the build-method capability gate.

    // Multi-service compose / one-click template deploy: deploy the project's
    // own compose stack, wired to Traefik on the generated domain. The compose
    // interpolates its ${VARS} from an env-file we write alongside it. Selecting
    // any other source (git, docker-image, …) switches away from the stack even
    // though the compose is kept for switching back; `source` is authoritative.
    // Legacy template projects predate the `compose` source, so fall back to the
    // old heuristic for them (compose present, no repo/image). An "upload" source
    // is explicit and must build the archive, so the heuristic never claims it —
    // even if a stale compose lingers from a previous source. See usesComposeStack.
    const hasCompose = Boolean(project.compose && project.compose.trim());
    const useCompose = usesComposeStack(project);
    if (useCompose && hasCompose) {
      const composeOpts = {
        depId,
        project,
        name,
        slug,
        domain,
        // Compose stacks route via their own service/port model (expose/exposes
        // + host pins). Per-domain ports don't apply, but a domain CAN pick a
        // service and/or a path prefix — pass the full routes so those become
        // per-route routers (the bare hostnames still drive the default expose).
        domains: routeDomains.map((d) => d.name),
        domainRoutes: routeDomains,
        environment: dep.environment,
        started,
      };
      // The owning agent runs the stack (it writes the mount files + env-file and
      // `compose up`s on its host), the host running Deplo included. The control
      // plane renders the stack YAML (buildComposeStack); the agent brings it up.
      await deployComposeStackViaAgent({ ...composeOpts, serverId: project.serverId });
      return;
    }

    let imageRef: string;
    let commitSha = "";
    // Set by the agent path when it fully built + ran this deploy. "failed" means
    // the agent reported a real build failure or was unreachable; "agent" means it
    // succeeded. Every deploy goes through the agent now — there is no in-process
    // build/run path — so this is always set by the time we settle.
    let agentOutcome: "agent" | "failed" | null = null;
    const serverId = project.serverId;

    // Per-server build-method capability gate. A heavy method (static/nixpacks/
    // buildpacks/railpack) needs the matching capability on THIS server's agent; an
    // older agent would accept the Deploy and only fail deep in its switch with an
    // opaque error. Gate on the advertised capability and fail with an actionable
    // "update the agent" message instead (mirrors the compose.multi gate + P5's
    // fail-fast-on-an-incapable-agent discipline). The Dockerfile family + a
    // prebuilt image need no heavy capability, so the check is skipped for them.
    const requiredCapability = agentCapabilityForMethod(project.build);
    if (requiredCapability) {
      try {
        const hello = await agentPreflight(serverId);
        if (!hello.capabilities.includes(requiredCapability)) {
          log(
            depId,
            "error",
            `This server's agent is too old to run the ${project.build.buildMethod} ` +
              `build method. Update the agent (reissue the install command from the ` +
              `server's actions menu).`,
          );
          await setDep(depId, { status: "error", buildDurationMs: Date.now() - started });
          await setProject(project.id, { status: "error" });
          return;
        }
      } catch (e) {
        log(
          depId,
          "error",
          `Agent unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        await setDep(depId, { status: "error", buildDurationMs: Date.now() - started });
        await setProject(project.id, { status: "error" });
        return;
      }
    }

    // Render the single-image stack the agent brings up. The control plane stays
    // the single source of truth for the compose (D2) and env decryption (D4);
    // both are computed here, once, and handed to the agent.
    const renderStack = async (
      image: string,
    ): Promise<{ composeYaml: string; env: Record<string, string> }> => {
      const env = await projectEnv(project.id);
      const basicAuthUsers = await basicAuthUsersValue(project.id);
      const composeYaml = renderCompose({
        name,
        image,
        port: project.build.port,
        projectId: project.id,
        slug,
        routes: routeDomains,
        env,
        basicAuthUsers,
        // A prebuilt image is deployed as-is — never inject PORT and override the
        // listen address its author baked in. Built sources (git/upload/dockerfile/
        // dev-workspace) DO get PORT so 12-factor apps bind where Traefik forwards.
        injectPort: project.source !== "docker-image",
        // The deploy path is the only writer of volumes into the stack — sourced
        // from the project. A reroute reads them back from the file instead.
        volumes: project.volumes ?? [],
      });
      return { composeYaml, env };
    };

    // For a BUILT source (git/upload/dev-workspace): resolve the build dir (one
    // shared rootDirectory containment), then ship the materialised tree to the
    // owning agent, which builds + runs it. The agent is the only execution path —
    // an unreachable agent is a hard deploy failure (P5), never a local fallback.
    const buildAndMaybeAgent = async (treeOpts: {
      workDir: string;
      root: string;
      imageRef: string;
      failOnMissing: boolean;
      notFoundMessage?: string;
    }): Promise<void> => {
      const { buildDir } = await buildImageFromTree({
        depId,
        project,
        slug,
        ...treeOpts,
        skipBuild: true, // the agent builds; we only resolve the dir
      });
      const { composeYaml, env } = await renderStack(treeOpts.imageRef);
      const { outcome } = await tryAgent({
        depId,
        serverId,
        project: { id: project.id, slug },
        imageRef: treeOpts.imageRef,
        composeYaml,
        env,
        plan: { kind: "dockerfile", buildDir, build: normalizeBuildConfig(project.build) },
      });
      agentOutcome = outcome === "agent" ? "agent" : "failed";
    };

    // Decide which source this deployment builds from (dev-workspace intent
    // overrides the project's own source; see planDeploySource). Each arm
    // materialises a tree (or pulls an image) then funnels through the shared
    // buildImageFromTree, so the rootDirectory containment + build dispatch live
    // in one place.
    const plan = planDeploySource(project, { buildSource: dep.buildSource });
    switch (plan.kind) {
      case "dev-workspace": {
        // EXPLICIT exception to "deploy never touches the dev workspace"
        // (CONTEXT.md): build production from the developer's live, edited tree
        // at /data/dev/<slug> — no git clone, no re-extract, no commit. Dev is
        // source-bearing only, so this is always a single-image build; guard
        // against a future source change silently routing a stack through here.
        if (
          !devWorkspaceDeployAllowed({
            usesComposeStack: usesComposeStack(project),
            source: project.source,
          })
        ) {
          throw new Error(
            "Deploy from dev workspace is only available for built (git/upload) projects",
          );
        }
        imageRef = `deplo/${slug}:${depId.slice(0, 12)}`;
        // The dev workspace lives on the OWNING AGENT's host (<dev-dir>/<slug>),
        // the host running Deplo included. The agent builds from its OWN workspace
        // via SOURCE_KIND_DEV_WORKSPACE (same exclude-set + symlink-reject guard
        // copyWorkspaceForBuild applied). No workspace bytes cross the wire.
        const { composeYaml, env } = await renderStack(imageRef);
        const { outcome } = await tryAgent({
          depId,
          serverId,
          project: { id: project.id, slug },
          imageRef,
          composeYaml,
          env,
          plan: {
            kind: "dev-workspace",
            build: normalizeBuildConfig(project.build),
            subdir: project.build.rootDirectory ?? "",
          },
        });
        agentOutcome = outcome === "agent" ? "agent" : "failed";
        break;
      }
      case "docker-image": {
        imageRef = plan.image;
        // A prebuilt image: the owning agent pulls + runs it on its host.
        const { composeYaml, env } = await renderStack(imageRef);
        const { outcome } = await tryAgent({
          depId,
          serverId,
          project: { id: project.id, slug },
          imageRef,
          composeYaml,
          env,
          plan: { kind: "image", image: plan.image },
        });
        agentOutcome = outcome === "agent" ? "agent" : "failed";
        break;
      }
      case "git": {
        const repo = plan.repo;
        // The OWNING AGENT clones the repo itself (PLAN Part B, D3), the host
        // running Deplo included, so the whole tree never crosses the wire — only
        // the descriptor does. The control plane resolves the authenticated clone
        // URL (short-lived token baked in for private GitHub) and hands the agent
        // the branch + subdir; the agent reports back the commit sha it checked out.
        const cloneUrl = await installationCloneUrl(
          repo.url,
          repo.installationId ?? null,
        );
        // The agent tags the image by the sha IT resolves; until then use the
        // deploy id as a placeholder tag (the rendered compose references this
        // same imageRef).
        imageRef = `deplo/${slug}:${depId.slice(0, 12)}`;
        const { composeYaml, env } = await renderStack(imageRef);
        log(depId, "command", `git clone ${repo.url} (${dep.branch}) [on agent]`);
        const attempt = await tryAgent({
          depId,
          serverId,
          project: { id: project.id, slug },
          imageRef,
          composeYaml,
          env,
          plan: {
            kind: "git",
            url: cloneUrl,
            branch: dep.branch,
            subdir: project.build.rootDirectory ?? "",
            build: normalizeBuildConfig(project.build),
          },
        });
        if (attempt.commitSha) {
          commitSha = attempt.commitSha;
          await setDep(depId, { commitSha });
        }
        agentOutcome = attempt.outcome === "agent" ? "agent" : "failed";
        break;
      }
      case "upload": {
        // Uploaded archive: extract into a temp dir, then build through the same
        // path as a git clone. extractArchive rejects any symlink in the archive
        // (so none can be followed out of the temp dir) and may return a subdir
        // (a tarball wrapped in one top-level folder). Upload historically does
        // NOT hard-fail an explicit-but-missing rootDirectory.
        const upload = plan.upload;
        const work = await mkdtemp(join(tmpdir(), "deplo-build-"));
        try {
          log(depId, "command", `extract ${upload.filename}`);
          const root = await extractArchive(upload, work, (line) =>
            log(depId, "info", line),
          );
          imageRef = `deplo/${slug}:${depId.slice(0, 12)}`;
          await buildAndMaybeAgent({
            workDir: work,
            root,
            imageRef,
            failOnMissing: false,
          });
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
        break;
      }
      default:
        throw new Error("Nothing to deploy: no Docker image or repository set");
    }

    // The agent built, rendered, ran, and waited — settle the deploy from its
    // terminal result. Every source arm above goes through the agent, so
    // `agentOutcome` is always set by the time we get here.
    const buildDurationMs = Date.now() - started;
    if (agentOutcome === "agent") {
      await setDep(depId, {
        status: "ready",
        readyAt: nowIso(),
        buildDurationMs,
        commitSha: commitSha || dep.commitSha,
      });
      await setProject(project.id, {
        status: "active",
        // No domain ⇒ dep.url is "" ⇒ null productionUrl (the container ran but
        // is unrouted until a domain is added back).
        ...(dep.environment === "production" ? { productionUrl: dep.url || null } : {}),
      });
      log(
        depId,
        "success",
        dep.url
          ? `Deployment ready at ${dep.url}`
          : "Deployment ready (no domain — add one to route traffic)",
      );
    } else {
      await setDep(depId, { status: "error", buildDurationMs });
      await setProject(project.id, { status: "error" });
    }
  } catch (e) {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    await setDep(depId, { status: "error", buildDurationMs: Date.now() - started });
    await setProject(project.id, { status: "error" });
  } finally {
    // GUARANTEED final flush (PLAN §6 Decision 18): every deploy end/error path —
    // success, build failure, agent-unavailable, a thrown error, or an early
    // return inside the try — persists the buffered build logs before the
    // fire-and-forget job exits, instead of relying on the periodic timer.
    await finalizeDeploymentLogs(depId);
  }
}

/**
 * Deploy a project's docker-compose stack (templates / multi-service apps).
 * Writes the stack and an env-file next to it, brings it up wired to Traefik on
 * the generated domain, and waits for the exposed service to come up.
 */
interface ComposeStackProject {
  id: string;
  compose: string | null;
  mounts?: { filePath: string; content: string }[] | null;
}

interface ComposeStackOpts {
  depId: string;
  project: ComposeStackProject;
  name: string;
  slug: string;
  domain: string;
  /** Public hostnames to route, primary first (no-host routes answer on all). */
  domains: string[];
  /** Every routable domain (the SOLE source of compose routing): each is one
   * Traefik router → its named compose service, on its port + path. Empty ⇒ the
   * stack is built and run but no routers are emitted (unrouted). */
  domainRoutes: RoutableDomain[];
  environment: DeploymentEnvironment;
  started: number;
}

/**
 * The host directory a project's compose stack reads its template config files
 * (mounts) from. buildComposeStack rewrites every `./<x>` bind source to
 * `<filesDir>/<x>`, so this path is baked into the rendered YAML — and MUST be
 * the same on whichever host runs the stack. The agent's default stack dir is
 * `/data/stacks` too (agent/main.go), so `<STACK_DIR>/files/<slug>` resolves
 * identically on the master and on a remote agent; the agent writes the mount
 * files there before bringing the stack up.
 */
function composeFilesDir(slug: string): string {
  return join(STACK_DIR, "files", slug);
}

/**
 * Register the extra hostnames a multi-domain template exposes and render the
 * project's compose stack to deployable YAML. Shared by the master path (which
 * then `compose up`s locally) and the remote/agent path (which ships the YAML to
 * the agent) so both deploy a byte-identical stack. Returns the rendered YAML and
 * the files dir the stack's mounts resolve to.
 */
async function prepareComposeStack(opts: ComposeStackOpts): Promise<{
  stackYaml: string;
  filesDir: string;
}> {
  const { project, name, slug, domainRoutes } = opts;

  // A multi-domain template's extra hostnames are registered ONCE at project
  // creation (createProject), NOT here — a deploy never creates domain rows, so
  // an extra domain the user deletes is never resurrected on the next deploy.
  // Routing reads the stored, valid domain set (routableForDeploy), independent
  // of any row this used to create.

  const filesDir = composeFilesDir(slug);
  const basicAuthUsers = await basicAuthUsersValue(project.id);
  // The settings env-var NAMES injected into every service as bare `- KEY`
  // pass-throughs — the value itself rides the env-file the agent writes (see
  // deployComposeStackViaAgent), so no secret lands in the rendered YAML.
  const envKeys = await projectEnvKeys(project.id);
  const stackYaml = buildComposeStack({
    compose: project.compose ?? "",
    name,
    slug,
    projectId: project.id,
    domainRoutes,
    filesDir,
    basicAuthUsers,
    envKeys,
  });
  return { stackYaml, filesDir };
}

/** Apply the terminal status of a compose-stack deploy (via the owning agent). */
async function finishComposeStack(
  opts: ComposeStackOpts,
  running: boolean,
): Promise<void> {
  const { depId, project, domain, environment, started } = opts;
  const buildDurationMs = Date.now() - started;
  // No domain ⇒ no URL: the stack ran but is unrouted until a domain is added.
  const url = domain ? `https://${domain}` : "";
  if (running) {
    await setDep(depId, { status: "ready", readyAt: nowIso(), buildDurationMs });
    await setProject(project.id, {
      status: "active",
      ...(environment === "production" ? { productionUrl: url || null } : {}),
    });
    log(
      depId,
      "success",
      url
        ? `Deployment ready at ${url}`
        : "Deployment ready (no domain — add one to route traffic)",
    );
  } else {
    await setDep(depId, { status: "error", buildDurationMs });
    await setProject(project.id, { status: "error" });
    log(depId, "error", "Stack did not reach a running state");
  }
}

/**
 * Deploy a multi-service compose stack via the owning server's agent (the host
 * running Deplo included). The control plane stays the source of truth: it
 * renders the stack YAML (prepareComposeStack) and decrypts the env, then hands
 * the agent a self-contained DeployRequest — the agent writes the mount files +
 * env-file on the owning host and `compose up`s there. There is no local
 * fallback, so an unreachable agent is a hard failure (P5). The agent reports
 * `ready` once the stack is running (it waits by the deplo.slug label, since a
 * multi-service stack's containers are compose-prefixed, not named deplo-<slug>).
 */
async function deployComposeStackViaAgent(
  opts: ComposeStackOpts & { serverId: string },
): Promise<void> {
  const { depId, project, slug, serverId } = opts;

  // A multi-service compose stack is a distinct source kind (SOURCE_KIND_COMPOSE).
  // The contract version is additive (still V1), so an OLD agent would accept the
  // Deploy call and only fail deep in its switch with "unknown source kind" — a
  // confusing error. Gate on the advertised capability instead and fail with an
  // actionable message (the operator must update the agent). Mirrors P5's
  // fail-fast-on-an-incapable-agent discipline.
  try {
    const hello = await agentPreflight(serverId);
    if (!hello.capabilities.includes("deploy.compose.multi")) {
      log(
        depId,
        "error",
        "This server's agent is too old to run multi-service compose stacks. " +
          "Update the agent (reissue the install command from the server's actions menu).",
      );
      await finishComposeStack(opts, false);
      return;
    }
  } catch (e) {
    log(
      depId,
      "error",
      `Remote agent unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
    await finishComposeStack(opts, false);
    return;
  }

  const { stackYaml } = await prepareComposeStack(opts);
  const env = await projectEnv(project.id);

  const { outcome } = await tryAgent({
    depId,
    serverId,
    project: { id: project.id, slug },
    // A compose stack has no single image_ref (each service brings its own); the
    // agent neither builds nor pulls one. Pass an empty ref.
    imageRef: "",
    composeYaml: stackYaml,
    env,
    plan: { kind: "compose", mounts: project.mounts ?? [] },
    // several images on the agent before any service reports running.
    readyTimeoutMs: 90_000,
  });

  // tryAgent already logged the failure reason / unreachable-agent message.
  await finishComposeStack(opts, outcome === "agent");
}


/**
 * Hostnames to bake into a deploy's Traefik rule. Production routes to every
 * verified domain (primary first) so a later primary-switch / new domain takes
 * effect via a reroute; a preview routes only to its ephemeral host (which is
 * not a registered domain). The pending primary is included as a fallback when
 * the project has a registered-but-not-yet-`valid` domain (e.g. the auto domain
 * on a brand-new project). When `primary` is "" the project has NO domain at all
 * (all deleted, never resurrected): production returns NO routes, so the deploy
 * proceeds unrouted (`traefik.enable=false`) instead of baking an empty rule.
 */
async function routableForDeploy(
  projectId: string,
  environment: DeploymentEnvironment,
  primary: string,
): Promise<RoutableDomain[]> {
  // A preview routes only to its ephemeral host, on the project default port.
  if (environment !== "production") return [defaultRoute(primary)];
  const valid = await routableRoutes(projectId);
  // No valid domain: route to the pending primary if there is one, else nothing.
  if (valid.length === 0) return primary ? [defaultRoute(primary)] : [];
  // Keep the canonical primary first even if it isn't flagged `valid` yet (it
  // carries its own port override + TLS choice if it has one; else the defaults).
  const primaryRoute =
    valid.find((d) => d.name === primary) ?? defaultRoute(primary);
  return [primaryRoute, ...valid.filter((d) => d.name !== primary)];
}

/** The `image:` baked into a single-image stack YAML, so a reroute reuses the
 * exact running image instead of rebuilding. Null if unreadable. The YAML is
 * read back from the OWNING agent's disk (conn.readStack), not a local file. */
function readStackImageFromYaml(
  stackYaml: string,
  service: string,
): string | null {
  try {
    const doc = yaml.load(stackYaml) as {
      services?: Record<string, { image?: unknown }>;
    } | null;
    const svc = doc?.services?.[service];
    return typeof svc?.image === "string" ? svc.image : null;
  } catch {
    return null;
  }
}

/** The `environment:` baked into a single-image stack YAML (map form, as
 * renderCompose writes it). Lets a reroute preserve the env the container is
 * actually running with instead of shipping pending edits from the store. */
function readStackEnvFromYaml(
  stackYaml: string,
  service: string,
): Record<string, string> | null {
  try {
    const doc = yaml.load(stackYaml) as {
      services?: Record<string, { environment?: unknown }>;
    } | null;
    const env = doc?.services?.[service]?.environment;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        out[k] = String(v);
      }
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The named volumes baked into a single-image stack file, read back so a reroute
 * preserves the mounts the container is ACTUALLY running with — never pulling a
 * pending (unsaved-to-stack) volume edit off the project. Mirrors
 * `readStackImage`/`readStackEnv`, keeping a reroute a pure routing change.
 * Parses each `- alias:/path[:ro]` service entry; the host name (top-level
 * `volumes.<alias>.name`) is irrelevant here — renderCompose re-derives it from
 * the slug. Key-indexed via yaml.load; do NOT refactor to positional parsing.
 */
/** The shape `renderCompose` accepts and `parseStackVolumes` reconstructs. */
type StackVolume = {
  type?: "named" | "project" | "host";
  name: string;
  projectPath?: string;
  hostPath?: string;
  mountPath: string;
  readOnly?: boolean;
};

function readStackVolumesFromYaml(
  stackYaml: string,
  service: string,
): StackVolume[] {
  try {
    return parseStackVolumes(stackYaml, service);
  } catch {
    return [];
  }
}

/**
 * The pure parser behind `readStackVolumes` (no fs) — exported for tests. Reads
 * the service `volumes:` lines back into the same shape `renderCompose` emitted,
 * so a reroute re-renders byte-identically. An absolute source under the
 * project's files dir (`<STACK_DIR>/files/<slug>/<rel>`) round-trips as a
 * "project" mount; any other absolute source is a HOST bind mount (`type:
 * "host"` with its `hostPath`); anything else is a docker-named volume alias.
 */
export function parseStackVolumes(
  yamlText: string,
  service: string,
): StackVolume[] {
  const doc = yaml.load(yamlText) as {
    services?: Record<string, { volumes?: unknown }>;
  } | null;
  const list = doc?.services?.[service]?.volumes;
  if (!Array.isArray(list)) return [];
  const filesRoot = join(STACK_DIR, "files") + "/";
  return list.flatMap((e) => {
    if (typeof e !== "string") return [];
    const [source, mountPath, flag] = e.split(":");
    if (!source || !mountPath) return [];
    const readOnly = flag === "ro";
    if (source.startsWith(filesRoot)) {
      // `<filesRoot><slug>/<rel>` — drop the slug segment, the rest is the
      // project-relative path the "project" mount was authored with.
      const afterRoot = source.slice(filesRoot.length);
      const slash = afterRoot.indexOf("/");
      const projectPath = slash >= 0 ? afterRoot.slice(slash + 1) : "";
      if (projectPath) {
        return [{ type: "project" as const, name: "", projectPath, mountPath, readOnly }];
      }
    }
    if (source.startsWith("/")) {
      return [{ type: "host" as const, name: "", hostPath: source, mountPath, readOnly }];
    }
    return [{ name: source, mountPath, readOnly }];
  });
}

/**
 * Re-apply a project's Traefik routing to its already-running stack, instantly
 * and without rebuilding. The router's `Host()` rule is baked into the
 * container's labels at deploy time, so switching the primary domain (or adding
 * / removing / verifying one) otherwise needs a full redeploy. This re-renders
 * the on-disk stack file with the project's current verified domains (primary
 * first) and runs `docker compose up -d`, which recreates only the routed
 * service in place; Traefik's Docker provider picks up the new labels within a
 * second or two. No image build, no git clone, no env regeneration.
 *
 * Returns a short status the caller surfaces to the user:
 *  - "rerouted"   — routing was re-applied to the running container
 *  - "unchanged"  — labels already matched; nothing to do (no restart)
 *  - "deferred"   — saved, but routing applies on the next deploy/start because
 *                   the project isn't currently active (idle/building/error) or
 *                   was never deployed; the stack file is still updated so the
 *                   correct labels are in place when it next comes up
 *
 * Throws only on an actual docker failure for an active project, so the caller's
 * toast reflects success/failure. Never starts a stopped (idle) project and
 * never races a deploy in progress (it re-renders the file but skips docker).
 */
export async function rerouteProject(
  projectId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const project = await loadProjectGraph(projectId);
  if (!project) return "deferred";
  const slug = project.slug;
  const name = `deplo-${slug}`;
  const serverId = await owningServerIdForSlug(slug);
  if (!serverId) return "deferred"; // no owning agent (server removed); nothing to do

  // Route exactly what a production DEPLOY would: every valid domain (primary
  // first) PLUS the pending primary as a fallback. Using routableForDeploy (not
  // bare routableRoutes) is what lets a freshly-ADDED primary domain take effect
  // on a Reload without a full redeploy — its row may not be `valid` yet, but the
  // deploy would still route it, so Reload must too. Empty ⇒ the project has no
  // domain at all (never resurrected): nothing to write, leave it deferred.
  const primary = await primaryDomainName(projectId);
  const routes = await routableForDeploy(projectId, "production", primary);
  if (routes.length === 0) return "deferred"; // never write an empty Host() rule

  const hasCompose = Boolean(project.compose && project.compose.trim());
  const useCompose = usesComposeStack(project);

  const conn = await connectAgent(serverId);
  try {
    // Read the rendered stack back from the OWNING agent's disk. Never deployed
    // (or torn down) => nothing running to reroute; the domain change is saved and
    // the next deploy bakes the right labels.
    const current = await conn.readStack(slug);
    if (!current.exists) return "deferred";

    // Re-render the stack with the new domain set (so the labels are correct
    // whenever the stack next comes up), reusing the running image and env.
    let rendered: string;
    let mounts: { path: string; content: string }[] = [];
    if (useCompose && hasCompose) {
      rendered = buildComposeStack({
        compose: project.compose ?? "",
        name,
        slug,
        projectId,
        // The `domains` table is the sole routing source: one router per routable
        // domain → its named compose service.
        domainRoutes: routes,
        filesDir: composeFilesDir(slug),
        basicAuthUsers: await basicAuthUsersValue(projectId),
        // Inject the current settings env-var names so a reroute keeps the same
        // pass-throughs a deploy would render — the env-file (sent below) still
        // carries the values. The no-op guard in mergeEnvironment means a reroute
        // that adds no new key re-renders byte-identically (no needless restart).
        envKeys: await projectEnvKeys(projectId),
      });
      mounts = (project.mounts ?? []).map((m) => ({
        path: m.filePath,
        content: m.content,
      }));
    } else {
      // Single-image / built path: the image ref and env live only in the stack
      // file (not on the project), so read them back from the agent's copy to keep
      // this a pure routing change — never a rebuild or a silent env/image change.
      const image = readStackImageFromYaml(current.yaml, name);
      if (!image) return "deferred"; // can't safely reroute without the running image
      const env = readStackEnvFromYaml(current.yaml, name) ?? await projectEnv(projectId);
      // Volumes are read back from the stack (like image/env), NOT from
      // project.volumes — so a domain-only reroute keeps the running mounts and
      // never silently applies a volume edit the user hasn't redeployed.
      const volumes = readStackVolumesFromYaml(current.yaml, name);
      const basicAuthUsers = await basicAuthUsersValue(projectId);
      rendered = renderCompose({
        name,
        image,
        port: project.build.port,
        projectId,
        slug,
        routes,
        env,
        basicAuthUsers,
        // Mirror the deploy path: a prebuilt image never carries an injected PORT,
        // so a domain-only reroute must not add one (it would diverge from the
        // running stack and force a needless container restart).
        injectPort: project.source !== "docker-image",
        volumes,
      });
    }

    // No-op when the labels already match — avoids a pointless container restart
    // (e.g. re-verifying an already-valid domain, or toggling primary back).
    if (current.yaml === rendered) return "unchanged";

    // Only an active project may be recreated. Recreating an idle (deliberately
    // stopped) project would silently restart it; recreating mid-deploy races the
    // deploy on the same compose project. For those, the agent still rewrites the
    // file (so the labels apply on next start/deploy) but does not bring it up.
    // We model that here by writing the file via a reroute only when active; for
    // non-active we defer (the next deploy/start renders + applies anyway).
    if (project.status !== "active") return "deferred";

    // For a single-image stack the env is baked into the YAML, so send no env-file
    // (mirrors the deploy path); compose stacks interpolate ${VAR} from the env.
    const env = useCompose && hasCompose ? await projectEnv(projectId) : {};
    const r = await conn.reroute({ slug, composeYaml: rendered, env, mounts });
    if (!r.ok) throw new Error(r.error || "agent failed to reroute the stack");
    return "rerouted";
  } finally {
    conn.close();
  }
}

/**
 * Render the full Deplo-generated stack for a project, for read-only display
 * (the "View full compose" button). This is the augmented YAML — Traefik +
 * deplo labels, the injected `deplo` network, absolute file-mount paths — i.e.
 * what `docker compose` actually runs, as opposed to the clean compose the user
 * authored and sees in the editor.
 *
 * Compose stacks are rendered live from the saved compose + current routable
 * domains, so the preview matches the NEXT deploy/reroute even before the
 * project is deployed. Single-image / built projects keep their image ref and
 * env only in the on-disk stack file (not on the project), so those are read
 * back from `/data/stacks/<slug>.yml`; that file exists only after a first
 * deploy. Returns `null` when there's nothing to show yet.
 */
export async function renderProjectStack(
  projectId: string,
): Promise<string | null> {
  const project = await loadProjectGraph(projectId);
  if (!project) return null;
  const slug = project.slug;
  const name = `deplo-${slug}`;

  const hasCompose = Boolean(project.compose && project.compose.trim());
  if (usesComposeStack(project) && hasCompose) {
    // Mirror the deploy/reroute call exactly so the preview is byte-faithful to
    // what would be written. The `domains` table is the sole routing source. A
    // never-deployed compose project still previews: fall back to ALL of the
    // project's domains (not just `valid` ones) so the preview isn't empty before
    // any domain is verified.
    const routes = await routableRoutes(projectId);
    const domainRoutes: RoutableDomain[] = routes.length
      ? routes
      : (await loadDomainsForProject(projectId))
          .sort((a, b) => Number(b.primary) - Number(a.primary))
          .map((d) => defaultRoute(d.name, d.service ?? null, d.port ?? null));
    return buildComposeStack({
      compose: project.compose ?? "",
      name,
      slug,
      projectId,
      domainRoutes,
      filesDir: composeFilesDir(slug),
      basicAuthUsers: await basicAuthUsersValue(projectId),
      // Show the injected pass-throughs in the preview so "View full compose"
      // matches what the next deploy/reroute writes. Only NAMES appear — the
      // values never enter the rendered YAML (they ride the env-file).
      envKeys: await projectEnvKeys(projectId),
    });
  }

  // Single-image / built: the rendered stack only exists on the OWNING agent's
  // disk after a deploy. Read it back over the wire; null when never deployed or
  // the agent is unreachable (the preview just shows nothing yet).
  const serverId = await owningServerIdForSlug(slug);
  if (!serverId) return null;
  const conn = await connectAgent(serverId);
  try {
    const { exists, yaml: stackYaml } = await conn.readStack(slug);
    return exists ? stackYaml : null;
  } catch {
    return null;
  } finally {
    conn.close();
  }
}

/**
 * Stop a project's stack via the owning server's agent StopStack (PLAN Part C).
 * The stack lives on the agent's daemon, the host running Deplo included. An
 * unreachable agent throws (the caller surfaces it; a stop must not silently
 * no-op). A no-op when the project/server is gone.
 */
export async function stopContainer(slug: string): Promise<void> {
  const serverId = await owningServerIdForSlug(slug);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.stopStack(slug);
    if (!r.ok) throw new Error(r.error || "agent failed to stop the stack");
  } finally {
    conn.close();
  }
}

/** Start a previously stopped stack via the owning agent's StartStack. */
export async function startContainer(slug: string): Promise<void> {
  const serverId = await owningServerIdForSlug(slug);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.startStack(slug);
    if (!r.ok) throw new Error(r.error || "agent failed to start the stack");
  } finally {
    conn.close();
  }
}

/**
 * Stop and remove a project's stack via the owning agent's DestroyStack. The
 * stack file, env file, and files dir live on the AGENT's disk (its DestroyStack
 * owns their teardown), the host running Deplo included. An unreachable agent
 * throws so the caller can warn about manual cleanup (P6 spirit).
 */
export async function destroyStack(slug: string): Promise<void> {
  const serverId = await owningServerIdForSlug(slug);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.destroyStack(slug);
    if (!r.ok) throw new Error(r.error || "agent failed to destroy the stack");
  } finally {
    conn.close();
  }
}
