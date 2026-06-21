import "server-only";

import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import yaml from "js-yaml";
import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { decryptSecret } from "../crypto";
import { resolveEnvEntries } from "./env-resolve";
import { recordActivity } from "../data/activity";
import { docker, ensureNetwork } from "../infra/docker";
import { spawnStream } from "../infra/exec";
import { cloneStream, revParse } from "../infra/git";
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
import { copyWorkspaceForBuild } from "./dev";
import {
  ensureAutoDomain,
  ensureExtraDomain,
  routableRoutes,
  defaultRoute,
  type RoutableDomain,
} from "../data/domains";
import { installationCloneUrl } from "../github/app";
import { publishProjectChanged } from "../graphql/pubsub";
import {
  agentCanHandle,
  runAgentDeploy,
  AgentUnavailableError,
  type AgentBuildPlan,
} from "./agent-deploy";
import { connectAgent, agentPreflight } from "../infra/agent-client";
import type { Deployment, DeploymentEnvironment, LogLine } from "../types";

/**
 * Whether a slug's project lives on a REMOTE server (its lifecycle verbs must
 * run on the owning agent, not the local docker socket). Resolved from the store.
 * A localhost / unknown server stays on the local path.
 */
function remoteServerIdForSlug(slug: string): string | null {
  const p = read().projects.find((x) => x.slug === slug);
  if (!p) return null;
  const server = read().servers.find((s) => s.id === p.serverId);
  return server?.type === "remote" ? server.id : null;
}

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const STACK_DIR = join(DATA_DIR, "stacks");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(depId: string, level: LogLine["level"], text: string): void {
  mutate((d) => {
    (d.logs[depId] ??= []).push({ ts: nowIso(), level, text });
  });
}

function setDep(depId: string, patch: Partial<Deployment>): void {
  let projectId: string | undefined;
  mutate((d) => {
    const x = d.deployments.find((y) => y.id === depId);
    if (x) {
      Object.assign(x, patch);
      projectId = x.projectId;
    }
  });
  // A deployment's status feeds the project's `latestDeployment` view, so push
  // the owning project to live subscribers when it changes.
  if (projectId && "status" in patch) publishProjectChanged(projectId);
}

function setProject(projectId: string, patch: Record<string, unknown>): void {
  mutate((d) => {
    const p = d.projects.find((x) => x.id === projectId);
    if (p) Object.assign(p, patch, { updatedAt: nowIso() });
  });
  publishProjectChanged(projectId);
}

/**
 * Decrypted env for the production stack: per-project vars targeting
 * `production`, plus attached shared groups that also target `production`.
 * Selection lives in the shared `resolveEnvEntries` seam; we only decrypt here.
 */
function projectEnv(projectId: string): Record<string, string> {
  const d = read();
  const out: Record<string, string> = {};
  for (const e of resolveEnvEntries(
    "production",
    projectId,
    d.envVars,
    d.sharedEnvGroups ?? [],
  )) {
    out[e.key] = decryptSecret(e.valueEnc);
  }
  return out;
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
}): string {
  const { name, image, port, projectId, slug, routes } = opts;
  const vols = opts.volumes ?? [];
  const namedVols = vols.filter((v) => v.type !== "host" && v.type !== "project");
  // Absolute, per-project files dir — the same sandbox the `./<x>` compose
  // convention resolves to. A "project" mount's source is rendered here so it
  // stays isolated (never resolved against the stack dir by docker).
  const filesDir = join(STACK_DIR, "files", slug);
  // Default PORT to the project's default container port so 12-factor apps
  // (buildpacks, Nixpacks, Railpack) bind where Traefik forwards. A user-set
  // PORT wins. Per-domain port overrides only change Traefik's target, not the
  // single PORT the container is told to listen on.
  const env = { PORT: String(port), ...opts.env };
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

async function streamDocker(
  args: string[],
  depId: string,
  timeout: number,
): Promise<void> {
  const code = await spawnStream(
    "docker",
    args,
    (line) => log(depId, "info", line),
    { timeout },
  );
  if (code !== 0) throw new Error(`docker ${args[0]} failed (exit ${code})`);
}

async function waitRunning(name: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await docker(
        ["inspect", "-f", "{{.State.Running}}", name],
        { timeout: 5_000 },
      );
      if (stdout.trim() === "true") return true;
    } catch {
      /* not up yet */
    }
    await sleep(2_000);
  }
  return false;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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
export function reconcileInFlightDeployments(): number {
  let reconciled = 0;
  const affectedProjects = new Set<string>();
  mutate((d) => {
    for (const dep of d.deployments) {
      if (isInFlightStatus(dep.status)) {
        dep.status = "error";
        reconciled++;
        affectedProjects.add(dep.projectId);
        (d.logs[dep.id] ??= []).push({
          ts: nowIso(),
          level: "error",
          text: "Deployment interrupted by a control-plane restart and marked failed.",
        });
      }
    }
    // A project left mid-deploy settles off the transient build state.
    for (const p of d.projects) {
      if ((p.status === "building" || p.status === "queued") && affectedProjects.has(p.id)) {
        p.status = "error";
        p.updatedAt = nowIso();
      }
    }
  });
  for (const projectId of affectedProjects) publishProjectChanged(projectId);
  if (reconciled > 0) {
    console.warn(
      `[deplo] reconciled ${reconciled} interrupted deployment(s) to error on startup`,
    );
  }
  return reconciled;
}

/**
 * Create a deployment record (queued) and kick off the real build in the
 * background. Returns the deployment id immediately; the job updates status and
 * logs as it progresses.
 */
export function startDeployment(
  projectId: string,
  opts: {
    environment?: DeploymentEnvironment;
    creator: string;
    commitMessage?: string;
    branch?: string;
    /** Build PRODUCTION from the dev workspace tree instead of the source. */
    buildSource?: "dev-workspace";
  },
): string {
  const project = read().projects.find((p) => p.id === projectId);
  if (!project) throw new Error("Project not found");
  const server = read().servers.find((s) => s.id === project.serverId);
  const ip = resolveServerIp(server);
  const environment = opts.environment ?? "production";
  const branch = opts.branch ?? project.repo?.branch ?? "main";
  // Production routes through the project's registered primary domain (created
  // here if missing) so the generated hostname is the same one shown in the
  // Domains section and baked into a template's env. Previews are ephemeral.
  const domain =
    environment === "production"
      ? ensureAutoDomain(projectId, {
          slug: project.slug,
          ip,
          // The primary host's default route: compose default expose, else
          // build.port. Keeps the auto domain complete (never portless).
          defaultPort: project.expose?.port ?? project.build.port,
          defaultService: project.expose?.service ?? null,
        })
      : previewDomain(project.slug, newId("").slice(1, 7), ip);
  const url = `https://${domain}`;
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

  mutate((d) => {
    d.deployments.push(dep);
    d.logs[depId] = [];
    const p = d.projects.find((x) => x.id === projectId);
    if (p) {
      p.latestDeploymentId = depId;
      p.status = "queued";
      p.updatedAt = nowIso();
      if (environment === "production") p.productionUrl = url;
    }
  });
  recordActivity("deployment", `Deploying ${project.name}`, opts.creator, projectId);
  // A new deployment flips the project to "queued" and sets latestDeployment —
  // push it to live subscribers so the header/tabs update without a reload.
  publishProjectChanged(projectId);

  // Fire-and-forget: the standalone Node server keeps the event loop alive.
  void runDeployment(depId).catch((e) => {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    setDep(depId, { status: "error" });
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
 * Render the single-image stack and stream it through the agent (PLAN Part A).
 * Returns "agent" when the agent fully built + ran the deploy, "local" when the
 * agent was unavailable (so the caller builds + runs locally as before). A clean
 * BUILD failure reported by the agent is NOT a fallback — it returns "failed",
 * and the caller marks the deploy errored without silently rebuilding locally.
 *
 * This is the choke point Part A introduces: the localhost server's deploy now
 * flows agent → control plane → pubsub for the Dockerfile/single-image path,
 * proving the contract with zero remote risk. Anything the agent can't handle
 * (heavy builders, compose stacks, agent down) takes the unchanged local path.
 */
/** The agent attempt's outcome + any commit sha the agent resolved (git source). */
interface AgentAttempt {
  outcome: "agent" | "local" | "failed";
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
  /** When true a transport failure is NOT a local fallback (remote has no local
   * path); it is a hard deploy failure. Set for remote servers. */
  noLocalFallback?: boolean;
  /** How long the agent waits for the stack to report running (ms). Defaults to
   * 60s (the single-image path); the compose path passes 90s to match the
   * master's waitStackRunning, since a multi-service stack may pull several
   * images first. */
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
      if (opts.noLocalFallback) {
        // A remote server has no local build path to fall back to: surface the
        // unreachable agent as a clear deploy failure (P5 — no hung deploys).
        log(
          opts.depId,
          "error",
          `Remote agent unavailable: ${e.message}`,
        );
        return { outcome: "failed", commitSha: "" };
      }
      log(
        opts.depId,
        "warn",
        `Agent unavailable (${e.message}); falling back to local build.`,
      );
      return { outcome: "local", commitSha: "" };
    }
    throw e;
  }
}

async function runDeployment(depId: string): Promise<void> {
  const started = Date.now();
  const dep = read().deployments.find((x) => x.id === depId);
  if (!dep) return;
  const project = read().projects.find((p) => p.id === dep.projectId);
  if (!project) {
    setDep(depId, { status: "error" });
    return;
  }
  const slug = project.slug;
  const name = `deplo-${slug}`;
  const stackFile = join(STACK_DIR, `${slug}.yml`);
  const server = read().servers.find((s) => s.id === project.serverId);
  const ip = resolveServerIp(server);
  const domain =
    dep.environment === "production"
      ? ensureAutoDomain(project.id, {
          slug,
          ip,
          defaultPort: project.expose?.port ?? project.build.port,
          defaultService: project.expose?.service ?? null,
        })
      : dep.url.replace(/^https?:\/\//, "");
  // Production routes to every verified domain (primary first); a preview uses
  // only its ephemeral host (not a registered domain). `domain` is always the
  // canonical primary and the fallback when nothing is verified yet.
  const routeDomains = routableForDeploy(project.id, dep.environment, domain);

  setDep(depId, { status: "building" });
  setProject(project.id, { status: "building" });

  try {
    await mkdir(STACK_DIR, { recursive: true });
    await ensureNetwork("deplo");

    // A REMOTE server can ONLY deploy what the agent supports — everything else
    // would silently build/run on the WRONG host (localhost's Docker). The heavy
    // builders (Nixpacks/Buildpacks/Railpack/static) aren't agent capabilities
    // yet, so a remote project using one fails clearly here rather than deploying
    // to the master. (Image + Dockerfile/auto + single-image compose go through
    // the agent below.) An unprovisioned remote also fails fast (P5).
    if (server?.type === "remote" && !agentCanHandle(project.build)) {
      log(
        depId,
        "error",
        "This build method can't yet deploy to a remote server (only Dockerfile/" +
          "auto builds and prebuilt images can). Switch the build method, or move " +
          "the project to the master server.",
      );
      setDep(depId, { status: "error", buildDurationMs: Date.now() - started });
      setProject(project.id, { status: "error" });
      return;
    }

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
        stackFile,
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
      // A REMOTE server runs the stack through the agent (the agent writes the
      // mount files + env-file and `compose up`s on the OWNING host); the master
      // brings it up directly on localhost's Docker. Both render the SAME stack
      // YAML (buildComposeStack), so routing/labels are byte-identical either way.
      if (server?.type === "remote") {
        await deployComposeStackViaAgent({ ...composeOpts, serverId: project.serverId });
      } else {
        await deployComposeStack(composeOpts);
      }
      return;
    }

    let imageRef: string;
    let commitSha = "";
    // Set by the agent path (PLAN Part A/B) when the agent fully built + ran this
    // deploy, so the post-switch LOCAL build + compose-up is skipped. "failed"
    // means the agent reported a real build failure (do NOT silently rebuild
    // locally); "agent" means it succeeded; null means the local path runs.
    let agentOutcome: "agent" | "failed" | null = null;
    const serverId = project.serverId;
    // A REMOTE server has no local build path: the agent is the ONLY way to
    // deploy there, so an unreachable agent is a hard failure, not a fallback
    // (P5). For localhost the legacy local path remains the fallback (Part A).
    const isRemote = server?.type === "remote";

    // Render the single-image stack the agent (or the local path) brings up. The
    // control plane stays the single source of truth for the compose (D2) and
    // env decryption (D4); both are computed here, once, and reused by whichever
    // path runs.
    const renderStack = (image: string): { composeYaml: string; env: Record<string, string> } => {
      const env = projectEnv(project.id);
      const composeYaml = renderCompose({
        name,
        image,
        port: project.build.port,
        projectId: project.id,
        slug,
        routes: routeDomains,
        env,
        // The deploy path is the only writer of volumes into the stack — sourced
        // from the project. A reroute reads them back from the file instead.
        volumes: project.volumes ?? [],
      });
      return { composeYaml, env };
    };

    // For a BUILT source (git/upload/dev-workspace): resolve the build dir (one
    // shared rootDirectory containment), then try the agent — building + running
    // from the materialised tree while it still exists. On agent-unavailable,
    // build locally HERE (tree alive) and let the post-switch compose-up run.
    const buildAndMaybeAgent = async (treeOpts: {
      workDir: string;
      root: string;
      imageRef: string;
      failOnMissing: boolean;
      notFoundMessage?: string;
    }): Promise<void> => {
      if (agentCanHandle(project.build)) {
        const { buildDir } = await buildImageFromTree({
          depId,
          project,
          slug,
          ...treeOpts,
          skipBuild: true, // the agent builds; we only resolve the dir
        });
        const { composeYaml, env } = renderStack(treeOpts.imageRef);
        const { outcome } = await tryAgent({
          depId,
          serverId,
          project: { id: project.id, slug },
          imageRef: treeOpts.imageRef,
          composeYaml,
          env,
          plan: { kind: "dockerfile", buildDir, build: normalizeBuildConfig(project.build) },
          noLocalFallback: isRemote,
        });
        if (outcome !== "local") {
          agentOutcome = outcome;
          return;
        }
        log(depId, "info", "Building locally instead.");
      }
      // Local fallback (or an ineligible build method): build the image in the
      // local store, exactly as before; the post-switch block runs the stack.
      // Unreachable for a remote server (noLocalFallback short-circuits above).
      await buildImageFromTree({ depId, project, slug, ...treeOpts });
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
        // REMOTE: the dev workspace lives on the AGENT's host, not here. The agent
        // builds from its OWN <dev-dir>/<slug> via SOURCE_KIND_DEV_WORKSPACE (same
        // exclude-set + symlink-reject guard copyWorkspaceForBuild applies). No
        // workspace bytes cross the wire; there is no local copy to make.
        if (isRemote && agentCanHandle(project.build)) {
          const { composeYaml, env } = renderStack(imageRef);
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
            noLocalFallback: true, // the workspace is on the agent, not here
          });
          agentOutcome = outcome === "agent" ? "agent" : "failed";
          break;
        }
        // LOCALHOST: the workspace is on this host — copy it into a build context.
        const work = await mkdtemp(join(tmpdir(), "deplo-build-"));
        try {
          log(depId, "command", "copy dev workspace");
          // copyWorkspaceForBuild excludes node_modules/.deplo/.deplo-home/.git
          // and rejects any planted symlink (the tree is UID-1000-controlled —
          // same threat model as an upload archive). Dependencies are
          // reinstalled by the build, exactly like a normal deploy.
          const root = await copyWorkspaceForBuild(slug, work, (line) =>
            log(depId, "info", line),
          );
          await buildAndMaybeAgent({
            workDir: work,
            root,
            imageRef,
            // Mirror the git arm: a typo'd rootDirectory on a deploy-to-
            // PRODUCTION must error loudly, not silently ship the workspace root.
            failOnMissing: true,
            notFoundMessage: `rootDirectory "${project.build.rootDirectory}" was not found in the dev workspace`,
          });
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
        break;
      }
      case "docker-image": {
        imageRef = plan.image;
        // A prebuilt image: the agent pulls + runs it (no local pull/build).
        if (agentCanHandle(null)) {
          const { composeYaml, env } = renderStack(imageRef);
          const { outcome } = await tryAgent({
            depId,
            serverId,
            project: { id: project.id, slug },
            imageRef,
            composeYaml,
            env,
            plan: { kind: "image", image: plan.image },
            noLocalFallback: isRemote,
          });
          if (outcome !== "local") {
            agentOutcome = outcome;
            break;
          }
          log(depId, "info", "Pulling locally instead.");
        }
        log(depId, "command", `docker pull ${plan.image}`);
        await streamDocker(["pull", plan.image], depId, 600_000);
        break;
      }
      case "git": {
        const repo = plan.repo;

        // REMOTE server (PLAN Part B, D3): the AGENT clones the repo itself, so
        // the whole tree never crosses the wire — only the descriptor does. The
        // control plane resolves the authenticated clone URL (short-lived token
        // baked in for private GitHub) and hands the agent the branch + subdir;
        // the agent reports back the commit sha it checked out.
        if (isRemote && agentCanHandle(project.build)) {
          const cloneUrl = await installationCloneUrl(
            repo.url,
            repo.installationId ?? null,
          );
          // The agent tags the image by the sha IT resolves; until then use the
          // deploy id as a placeholder tag (the agent renames are not needed —
          // the rendered compose references this same imageRef).
          imageRef = `deplo/${slug}:${depId.slice(0, 12)}`;
          const { composeYaml, env } = renderStack(imageRef);
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
            noLocalFallback: true, // remote has no local clone path
          });
          if (attempt.commitSha) {
            commitSha = attempt.commitSha;
            setDep(depId, { commitSha });
          }
          agentOutcome = attempt.outcome === "agent" ? "agent" : "failed";
          break;
        }

        // LOCALHOST (or an agent-ineligible build): the control plane clones,
        // then builds locally or hands the materialised tree to the local agent.
        const work = await mkdtemp(join(tmpdir(), "deplo-build-"));
        try {
          // Private GitHub repos clone through the connected App's short-lived
          // installation token; everything else uses the URL as-is. The token
          // is never logged.
          const cloneUrl = await installationCloneUrl(
            repo.url,
            repo.installationId ?? null,
          );
          log(depId, "command", `git clone ${repo.url} (${dep.branch})`);
          await cloneStream(cloneUrl, dep.branch, work, (line) =>
            log(depId, "info", line),
          );
          commitSha = await revParse(work);
          if (commitSha) setDep(depId, { commitSha });
          imageRef = `deplo/${slug}:${(commitSha || depId).slice(0, 12)}`;
          await buildAndMaybeAgent({
            workDir: work,
            root: work,
            imageRef,
            failOnMissing: true,
            notFoundMessage: `rootDirectory "${project.build.rootDirectory}" was not found in the repository`,
          });
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
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

    // The agent already built, rendered, ran, and waited — settle the deploy
    // from its terminal result without touching the local Docker path.
    if (agentOutcome !== null) {
      const buildDurationMs = Date.now() - started;
      if (agentOutcome === "agent") {
        setDep(depId, {
          status: "ready",
          readyAt: nowIso(),
          buildDurationMs,
          commitSha: commitSha || dep.commitSha,
        });
        setProject(project.id, {
          status: "active",
          ...(dep.environment === "production" ? { productionUrl: dep.url } : {}),
        });
        log(depId, "info", `Deployment ready at ${dep.url}`);
      } else {
        setDep(depId, { status: "error", buildDurationMs });
        setProject(project.id, { status: "error" });
      }
      return;
    }

    const { composeYaml } = renderStack(imageRef);
    await writeFile(stackFile, composeYaml);

    log(depId, "command", "docker compose up -d");
    await streamDocker(
      ["compose", "-p", name, "-f", stackFile, "up", "-d", "--remove-orphans"],
      depId,
      300_000,
    );

    log(depId, "info", "Waiting for the container to become healthy…");
    const running = await waitRunning(name, 60_000);
    const buildDurationMs = Date.now() - started;

    if (running) {
      setDep(depId, {
        status: "ready",
        readyAt: nowIso(),
        buildDurationMs,
        commitSha: commitSha || dep.commitSha,
      });
      setProject(project.id, {
        status: "active",
        ...(dep.environment === "production" ? { productionUrl: dep.url } : {}),
      });
      log(depId, "info", `Deployment ready at ${dep.url}`);
    } else {
      setDep(depId, { status: "error", buildDurationMs });
      setProject(project.id, { status: "error" });
      log(depId, "error", "Container did not reach a running state");
    }
  } catch (e) {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    setDep(depId, { status: "error", buildDurationMs: Date.now() - started });
    setProject(project.id, { status: "error" });
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
  expose: { service: string; port: number } | null;
  exposes?: { service: string; port: number; host?: string }[] | null;
  mounts?: { filePath: string; content: string }[] | null;
}

interface ComposeStackOpts {
  depId: string;
  project: ComposeStackProject;
  name: string;
  slug: string;
  stackFile: string;
  domain: string;
  /** Public hostnames to route, primary first (no-host routes answer on all). */
  domains: string[];
  /** Per-domain service/path overrides (routes that target a chosen compose
   * service and/or a path prefix); empty ⇒ default expose routing only. */
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
function prepareComposeStack(opts: ComposeStackOpts): {
  stackYaml: string;
  filesDir: string;
} {
  const { project, name, slug, domain, domains, domainRoutes, environment } =
    opts;

  // Register every extra hostname a multi-domain template exposes (the primary
  // domain is already registered by the caller) so each shows up in the project's
  // Domains section and Traefik gets a router per host. Production only.
  if (environment === "production") {
    for (const ex of project.exposes ?? []) {
      const host = ex.host?.trim();
      // Each extra host's default route IS the exposes entry it came from, so
      // pass that service + port — the row is born complete and renders as the
      // default route (byte-identical to the pre-backfill output).
      if (host && host !== domain)
        ensureExtraDomain(project.id, host, {
          port: ex.port,
          service: ex.service,
        });
    }
  }

  const filesDir = composeFilesDir(slug);
  const stackYaml = buildComposeStack({
    compose: project.compose ?? "",
    name,
    slug,
    projectId: project.id,
    domains,
    domainRoutes,
    expose: project.expose ?? null,
    exposes: project.exposes ?? undefined,
    filesDir,
  });
  return { stackYaml, filesDir };
}

/** Apply the terminal status of a compose-stack deploy (master or agent). */
function finishComposeStack(
  opts: ComposeStackOpts,
  running: boolean,
): void {
  const { depId, project, domain, environment, started } = opts;
  const buildDurationMs = Date.now() - started;
  const url = `https://${domain}`;
  if (running) {
    setDep(depId, { status: "ready", readyAt: nowIso(), buildDurationMs });
    setProject(project.id, {
      status: "active",
      ...(environment === "production" ? { productionUrl: url } : {}),
    });
    log(depId, "info", `Deployment ready at ${url}`);
  } else {
    setDep(depId, { status: "error", buildDurationMs });
    setProject(project.id, { status: "error" });
    log(depId, "error", "Stack did not reach a running state");
  }
}

async function deployComposeStack(opts: ComposeStackOpts): Promise<void> {
  const { depId, project, name, slug, stackFile } = opts;

  // Materialise any template config files into the project's isolated files dir
  // (referenced by the compose as ./<x>) BEFORE the stack comes up.
  const { stackYaml, filesDir } = prepareComposeStack(opts);
  if (project.mounts?.length) {
    await writeMountFiles(filesDir, project.mounts, depId);
  }
  await writeFile(stackFile, stackYaml);

  // Env-file for ${VAR} interpolation. Written 0600 since it holds secrets.
  const env = projectEnv(project.id);
  const envFile = join(STACK_DIR, `${slug}.env`);
  await writeFile(envFile, renderEnvFile(env), { mode: 0o600 });

  log(depId, "command", "docker compose up -d");
  await streamDocker(
    [
      "compose",
      "-p",
      name,
      "-f",
      stackFile,
      "--env-file",
      envFile,
      "up",
      "-d",
      "--remove-orphans",
    ],
    depId,
    600_000,
  );

  log(depId, "info", "Waiting for the stack to become healthy…");
  const running = await waitStackRunning(slug, 90_000);
  finishComposeStack(opts, running);
}

/**
 * Deploy a multi-service compose stack to a REMOTE server via its agent. The
 * control plane stays the source of truth: it renders the SAME stack YAML as the
 * master path (prepareComposeStack) and decrypts the env, then hands the agent a
 * self-contained DeployRequest — the agent writes the mount files + env-file on
 * the owning host and `compose up`s there. A remote server has no local fallback,
 * so an unreachable agent is a hard failure (P5), exactly like the single-image
 * remote path. The agent reports `ready` once the stack is running (it waits by
 * the deplo.slug label, since a multi-service stack's containers are
 * compose-prefixed, not named deplo-<slug>).
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
          "Update the agent (reissue the install command from the server's actions menu), " +
          "or move this project to the master server.",
      );
      finishComposeStack(opts, false);
      return;
    }
  } catch (e) {
    log(
      depId,
      "error",
      `Remote agent unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
    finishComposeStack(opts, false);
    return;
  }

  const { stackYaml } = prepareComposeStack(opts);
  const env = projectEnv(project.id);

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
    noLocalFallback: true,
    // Match the master's 90s waitStackRunning — a multi-service stack may pull
    // several images on the agent before any service reports running.
    readyTimeoutMs: 90_000,
  });

  // tryAgent already logged the failure reason / unreachable-agent message.
  finishComposeStack(opts, outcome === "agent");
}

/**
 * Write template config files into the project's files dir, guarding against
 * path escape. Each filePath is treated as relative to filesDir; any `..`
 * segment or absolute path is rejected.
 */
async function writeMountFiles(
  filesDir: string,
  mounts: { filePath: string; content: string }[],
  depId: string,
): Promise<void> {
  for (const mount of mounts) {
    const rel = mount.filePath.replace(/^\.\/+/, "").replace(/^\/+/, "");
    if (rel.split(/[\\/]/).includes("..") || rel === "") {
      log(depId, "warn", `Skipping unsafe mount path: ${mount.filePath}`);
      continue;
    }
    const target = join(filesDir, rel);
    await mkdir(dirname(target), { recursive: true });
    // 0644: these are bind-mounted into the app container, which may run as a
    // non-root user and must be able to read its own config.
    await writeFile(target, mount.content, { mode: 0o644 });
  }
}

/** Serialize env to docker-compose env-file lines (KEY=VALUE, no quoting). */
function renderEnvFile(env: Record<string, string>): string {
  return (
    Object.entries(env)
      // env-file values are literal; strip newlines that would break the format.
      .map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, " ")}`)
      .join("\n") + "\n"
  );
}

/** Wait for a compose stack's exposed (Traefik-labelled) service to be running. */
async function waitStackRunning(slug: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await docker(
        [
          "ps",
          "-q",
          "--filter",
          `label=deplo.slug=${slug}`,
          "--filter",
          "status=running",
        ],
        { timeout: 5_000 },
      );
      if (stdout.trim()) return true;
    } catch {
      /* not up yet */
    }
    await sleep(2_000);
  }
  return false;
}

function stackFilePath(slug: string): string {
  return join(STACK_DIR, `${slug}.yml`);
}

/**
 * Hostnames to bake into a deploy's Traefik rule. Production routes to every
 * verified domain (primary first) so a later primary-switch / new domain takes
 * effect via a reroute; a preview routes only to its ephemeral host (which is
 * not a registered domain). `primary` is always included as the fallback when
 * the project has no verified domain yet (e.g. the freshly-created auto domain
 * hasn't been marked `valid` on a brand-new project — never emit an empty rule).
 */
function routableForDeploy(
  projectId: string,
  environment: DeploymentEnvironment,
  primary: string,
): RoutableDomain[] {
  // A preview routes only to its ephemeral host, on the project default port.
  if (environment !== "production") return [defaultRoute(primary)];
  const valid = routableRoutes(projectId);
  if (valid.length === 0) return [defaultRoute(primary)];
  // Keep the canonical primary first even if it isn't flagged `valid` yet (it
  // carries its own port override + TLS choice if it has one; else the defaults).
  const primaryRoute =
    valid.find((d) => d.name === primary) ?? defaultRoute(primary);
  return [primaryRoute, ...valid.filter((d) => d.name !== primary)];
}

/** The `image:` baked into a single-image stack file, so a reroute reuses the
 * exact running image instead of rebuilding. Null if unreadable. */
async function readStackImage(
  stackFile: string,
  service: string,
): Promise<string | null> {
  try {
    const doc = yaml.load(await readFile(stackFile, "utf8")) as {
      services?: Record<string, { image?: unknown }>;
    } | null;
    const svc = doc?.services?.[service];
    return typeof svc?.image === "string" ? svc.image : null;
  } catch {
    return null;
  }
}

/** The `environment:` baked into a single-image stack file (map form, as
 * renderCompose writes it). Lets a reroute preserve the env the container is
 * actually running with instead of shipping pending edits from the store. */
async function readStackEnv(
  stackFile: string,
  service: string,
): Promise<Record<string, string> | null> {
  try {
    const doc = yaml.load(await readFile(stackFile, "utf8")) as {
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

async function readStackVolumes(
  stackFile: string,
  service: string,
): Promise<StackVolume[]> {
  try {
    return parseStackVolumes(await readFile(stackFile, "utf8"), service);
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
  const project = read().projects.find((p) => p.id === projectId);
  if (!project) return "deferred";
  const slug = project.slug;
  const name = `deplo-${slug}`;
  const stackFile = stackFilePath(slug);

  // Never deployed (or torn down): nothing running to reroute. The domain change
  // is already saved; the next deploy bakes the right labels.
  if (!(await fileExists(stackFile))) return "deferred";

  const routes = routableRoutes(projectId);
  if (routes.length === 0) return "deferred"; // never write an empty Host() rule

  const hasCompose = Boolean(project.compose && project.compose.trim());
  const useCompose = usesComposeStack(project);

  // Re-render the stack file with the new domain set (so the labels are correct
  // whenever the stack next comes up), reusing the running image and env.
  let rendered: string;
  if (useCompose && hasCompose) {
    rendered = buildComposeStack({
      compose: project.compose ?? "",
      name,
      slug,
      projectId,
      // Compose stacks route via their own service/port model; per-domain port
      // overrides apply only to single-image projects, but a domain can pick a
      // service and/or path prefix (per-route routers).
      domains: routes.map((d) => d.name),
      domainRoutes: routes,
      expose: project.expose ?? null,
      exposes: project.exposes ?? undefined,
      filesDir: join(STACK_DIR, "files", slug),
    });
  } else {
    // Single-image / built path: the image ref and env live only in the stack
    // file (not on the project), so read them back to keep this a pure routing
    // change — never a rebuild or a silent env/image change.
    const image = await readStackImage(stackFile, name);
    if (!image) return "deferred"; // can't safely reroute without the running image
    const env = (await readStackEnv(stackFile, name)) ?? projectEnv(projectId);
    // Volumes are read back from the stack (like image/env), NOT from
    // project.volumes — so a domain-only reroute keeps the running mounts and
    // never silently applies a volume edit the user hasn't redeployed.
    const volumes = await readStackVolumes(stackFile, name);
    rendered = renderCompose({
      name,
      image,
      port: project.build.port,
      projectId,
      slug,
      routes,
      env,
      volumes,
    });
  }

  // No-op when the labels already match — avoids a pointless container restart
  // (e.g. re-verifying an already-valid domain, or toggling primary back).
  const current = await readFile(stackFile, "utf8").catch(() => "");
  if (current === rendered) return "unchanged";

  await writeFile(stackFile, rendered);

  // Only an active project may be recreated. Recreating an idle (deliberately
  // stopped) project would silently restart it; recreating mid-deploy races the
  // deploy on the same compose project. In both cases the file is now correct
  // and the labels apply on the next start/deploy.
  if (project.status !== "active") return "deferred";

  await ensureNetwork("deplo");
  const args = ["compose", "-p", name, "-f", stackFile];
  if (useCompose && hasCompose) {
    const envFile = join(STACK_DIR, `${slug}.env`);
    if (await fileExists(envFile)) args.push("--env-file", envFile);
  }
  await docker([...args, "up", "-d", "--remove-orphans"], { timeout: 120_000 });
  return "rerouted";
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
  const store = read();
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const slug = project.slug;
  const name = `deplo-${slug}`;

  const hasCompose = Boolean(project.compose && project.compose.trim());
  if (usesComposeStack(project) && hasCompose) {
    // Mirror the deploy/reroute call exactly so the preview is byte-faithful to
    // what would be written. A never-deployed compose project still previews:
    // fall back to ALL of the project's domains (not just routable ones) so the
    // Host() rule isn't empty before any domain is verified.
    const routes = routableRoutes(projectId);
    const domains = routes.length
      ? routes.map((d) => d.name)
      : store.domains
          .filter((d) => d.projectId === projectId)
          .sort((a, b) => Number(b.primary) - Number(a.primary))
          .map((d) => d.name);
    return buildComposeStack({
      compose: project.compose ?? "",
      name,
      slug,
      projectId,
      domains,
      // Mirror the deploy/reroute call so the preview is byte-faithful. Only
      // `valid` routes carry per-domain overrides; the all-domains fallback (for
      // a never-deployed stack) routes via the default expose, no overrides.
      domainRoutes: routes,
      expose: project.expose ?? null,
      exposes: project.exposes ?? undefined,
      filesDir: join(STACK_DIR, "files", slug),
    });
  }

  // Single-image / built: the rendered stack only exists on disk after a deploy.
  const stackFile = stackFilePath(slug);
  if (!(await fileExists(stackFile))) return null;
  return readFile(stackFile, "utf8").catch(() => null);
}

/**
 * Stop a project's stack (compose-managed; falls back to the single container).
 * A REMOTE project (PLAN Part C) routes to the owning agent's StopStack — the
 * stack lives on the agent's daemon, not the local socket. An unreachable agent
 * throws (the caller surfaces it; a stop must not silently no-op).
 */
export async function stopContainer(slug: string): Promise<void> {
  const remoteId = remoteServerIdForSlug(slug);
  if (remoteId) {
    const conn = await connectAgent(remoteId);
    try {
      const r = await conn.stopStack(slug);
      if (!r.ok) throw new Error(r.error || "agent failed to stop the stack");
    } finally {
      conn.close();
    }
    return;
  }
  const stackFile = stackFilePath(slug);
  if (await fileExists(stackFile)) {
    await docker(["compose", "-p", `deplo-${slug}`, "-f", stackFile, "stop"], {
      timeout: 60_000,
    });
    return;
  }
  await docker(["stop", `deplo-${slug}`], { timeout: 30_000 });
}

/** Start a previously stopped stack (remote -> owning agent's StartStack). */
export async function startContainer(slug: string): Promise<void> {
  const remoteId = remoteServerIdForSlug(slug);
  if (remoteId) {
    const conn = await connectAgent(remoteId);
    try {
      const r = await conn.startStack(slug);
      if (!r.ok) throw new Error(r.error || "agent failed to start the stack");
    } finally {
      conn.close();
    }
    return;
  }
  const stackFile = stackFilePath(slug);
  if (await fileExists(stackFile)) {
    await docker(["compose", "-p", `deplo-${slug}`, "-f", stackFile, "start"], {
      timeout: 60_000,
    });
    return;
  }
  await docker(["start", `deplo-${slug}`], { timeout: 30_000 });
}

/**
 * Stop and remove a project's stack. A REMOTE project routes to the owning
 * agent's DestroyStack — and the local file cleanup below is DELIBERATELY skipped
 * for it: the stack file, env file, and files dir live on the AGENT's disk
 * (the agent's DestroyStack owns their teardown), so an rm here would target the
 * wrong host (and there is nothing local to remove). An unreachable agent throws
 * so the caller can warn about manual cleanup (P6 spirit).
 */
export async function destroyStack(slug: string): Promise<void> {
  const remoteId = remoteServerIdForSlug(slug);
  if (remoteId) {
    const conn = await connectAgent(remoteId);
    try {
      const r = await conn.destroyStack(slug);
      if (!r.ok) throw new Error(r.error || "agent failed to destroy the stack");
    } finally {
      conn.close();
    }
    return;
  }
  const stackFile = stackFilePath(slug);
  const envFile = join(STACK_DIR, `${slug}.env`);
  const args = ["compose", "-p", `deplo-${slug}`, "-f", stackFile];
  if (await fileExists(envFile)) args.push("--env-file", envFile);
  try {
    await docker([...args, "down", "--remove-orphans"], { timeout: 90_000 });
  } catch {
    // Fall back to removing a single labelled container directly.
    await docker(["rm", "-f", `deplo-${slug}`], { timeout: 30_000 }).catch(
      () => {},
    );
  }
  await rm(stackFile, { force: true }).catch(() => {});
  await rm(envFile, { force: true }).catch(() => {});
  await rm(join(STACK_DIR, "files", slug), {
    recursive: true,
    force: true,
  }).catch(() => {});
}
