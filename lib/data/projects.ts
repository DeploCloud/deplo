import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import { buildConfigFor, normalizeBuildConfig } from "../frameworks";
import type {
  BuildConfig,
  Deployment,
  DeploySource,
  EnvTarget,
  FrameworkId,
  GitRepo,
  Project,
  UploadArchive,
} from "../types";
import {
  startDeployment,
  stopContainer,
  startContainer,
} from "../deploy/build";
import { ensureAutoDomain } from "./domains";
import { resolveServerIp } from "../deploy/domains";
import { teardownProject } from "./deployments";
import { teardownDev } from "../deploy/dev";
import { removeUploads } from "../deploy/upload";
import { removeProjectDevSshUsers } from "./dev-ssh";

/** Heuristic: treat secret-looking keys as masked secrets. */
function isSecretKey(key: string): boolean {
  return /pass|secret|token|key|api|private|credential|dsn|url/i.test(key);
}

export interface ProjectSummary extends Project {
  latestDeployment: Deployment | null;
  domainCount: number;
}

/**
 * Backfill a project read from the store to the current model. The legacy
 * "dockerfile" deploy source was folded into the "dockerfile" build method
 * (build from the repo's Dockerfile is *how* you build, not *where* code comes
 * from), so old projects on that source are remapped to a plain git/github
 * source with their build method forced to "dockerfile". Pure and idempotent.
 */
function normalizeProject<T extends Project>(p: T): T {
  const build = normalizeBuildConfig(p.build);
  const legacySource = (p.source as string) === "dockerfile";
  if (!legacySource && build === p.build) return p;
  return {
    ...p,
    source: legacySource
      ? p.repo?.provider === "github"
        ? "github"
        : "git"
      : p.source,
    build: legacySource ? { ...build, buildMethod: "dockerfile" } : build,
  };
}

function summarize(p: Project): ProjectSummary {
  const d = read();
  const np = normalizeProject(p);
  const latest = np.latestDeploymentId
    ? d.deployments.find((x) => x.id === np.latestDeploymentId) || null
    : null;
  return {
    ...np,
    latestDeployment: latest,
    domainCount: d.domains.filter((x) => x.projectId === np.id).length,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await assertUser();
  return read()
    .projects.map(summarize)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getProjectBySlug(
  slug: string
): Promise<ProjectSummary | null> {
  await assertUser();
  const p = read().projects.find((x) => x.slug === slug);
  return p ? summarize(p) : null;
}

export async function getProjectById(id: string): Promise<Project | null> {
  await assertUser();
  const p = read().projects.find((x) => x.id === id);
  return p ? normalizeProject(p) : null;
}

export interface CreateProjectInput {
  name: string;
  framework: FrameworkId;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage?: string | null;
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
  const user = await assertUser();
  const slugBase = input.name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const existing = new Set(read().projects.map((p) => p.slug));
  let slug = slugBase || `project-${newId("").slice(1, 6)}`;
  let i = 1;
  while (existing.has(slug)) slug = `${slugBase}-${i++}`;

  const team = read().teams[0];
  const servers = read().servers;
  // Default to the master (localhost) server; honour an explicit, existing pick.
  const server =
    (input.serverId && servers.find((s) => s.id === input.serverId)) ||
    servers.find((s) => s.type === "localhost") ||
    servers[0];
  const project: Project = {
    id: newId("prj"),
    name: input.name.trim(),
    slug,
    teamId: team.id,
    serverId: server.id,
    framework: input.framework,
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
    productionUrl: null,
    status: "queued",
    autoDeploy: input.autoDeploy ?? true,
    latestDeploymentId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  // Initial environment variables (e.g. a template's defaults), encrypted at rest.
  const now = nowIso();
  const envVars = (input.env ?? [])
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

  mutate((d) => {
    d.projects.push(project);
    d.envVars.push(...envVars);
  });
  recordActivity("project", `Created project ${project.name}`, user.name, project.id);

  // Register the generated sslip.io domain so it shows up in the project's
  // Domains section immediately and the deploy routes to the same hostname a
  // template baked into its env.
  const ip = resolveServerIp(server);
  ensureAutoDomain(project.id, {
    slug,
    ip,
    preferred: input.autoDomain ?? undefined,
  });

  // An "upload" project has no archive at creation (it is uploaded from the
  // Settings page afterward, which triggers its own deploy via the upload
  // route). Deploying now would fail with "Nothing to deploy", so leave it
  // idle instead of stuck queued / errored.
  if (project.source === "upload") {
    mutate((d) => {
      const p = d.projects.find((x) => x.id === project.id);
      if (p) p.status = "idle";
    });
  } else {
    // Kick off the first real build + deploy. Runs in the background and flips
    // the project to active (or error) once the container is up.
    startDeployment(project.id, {
      environment: "production",
      creator: user.name,
      commitMessage: input.repo ? "Initial import" : "Initial deployment",
    });
  }

  return summarize(read().projects.find((x) => x.id === project.id)!);
}

export async function updateProjectBuild(
  id: string,
  build: Partial<BuildConfig>
): Promise<void> {
  const user = await assertUser();
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id);
    if (!p) throw new Error("Project not found");
    p.build = { ...p.build, ...build };
    p.framework = build.framework ?? p.framework;
    p.updatedAt = nowIso();
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
  const user = await assertUser();
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id);
    if (!p) throw new Error("Project not found");
    if (input.serverId) {
      const server = d.servers.find((s) => s.id === input.serverId);
      if (!server) throw new Error("Server not found");
      p.serverId = server.id;
    }
    p.source = input.source;
    p.repo = input.repo;
    p.dockerImage = input.dockerImage;
    // Persist compose edits when provided; never clear a stored stack on switch
    // so the user can flip back to the Compose source and recover it.
    if (input.compose != null) p.compose = input.compose;
    if (input.expose !== undefined) p.expose = input.expose;
    if (input.exposes !== undefined) p.exposes = input.exposes;
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Updated deploy source`, user.name, id);
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
  const user = await assertUser();
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id);
    if (!p) throw new Error("Project not found");
    p.source = "upload";
    p.upload = upload;
    p.repo = null;
    p.dockerImage = null;
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Uploaded ${upload.filename}`, user.name, id);
}

export async function setAutoDeploy(id: string, value: boolean): Promise<void> {
  await assertUser();
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id);
    if (!p) throw new Error("Project not found");
    p.autoDeploy = value;
    p.updatedAt = nowIso();
  });
}

export async function renameProject(id: string, name: string): Promise<void> {
  const user = await assertUser();
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id);
    if (!p) throw new Error("Project not found");
    p.name = name.trim();
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Renamed project to ${name}`, user.name, id);
}

/** Stop the project's running container. */
export async function stopProject(id: string): Promise<void> {
  const user = await assertUser();
  const project = read().projects.find((x) => x.id === id);
  if (!project) throw new Error("Project not found");
  await stopContainer(project.slug).catch(() => {});
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id)!;
    p.status = "idle";
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Stopped ${project.name}`, user.name, id);
}

/** Start a previously stopped project's container. */
export async function startProject(id: string): Promise<void> {
  const user = await assertUser();
  const project = read().projects.find((x) => x.id === id);
  if (!project) throw new Error("Project not found");
  await startContainer(project.slug).catch(() => {});
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id)!;
    p.status = "active";
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Started ${project.name}`, user.name, id);
}

/** Rebuild the image from the current source and redeploy (real build). */
export async function rebuildProject(id: string): Promise<void> {
  const user = await assertUser();
  const project = read().projects.find((x) => x.id === id);
  if (!project) throw new Error("Project not found");
  startDeployment(id, {
    environment: "production",
    creator: user.name,
    commitMessage: "Rebuild container",
  });
}

export async function deleteProject(id: string): Promise<void> {
  const user = await assertUser();
  const project = read().projects.find((x) => x.id === id);
  if (!project) throw new Error("Project not found");
  // Tear down the running container/stack before dropping the records.
  await teardownProject(project.slug);
  // Dev mode: tear down the dev container + deps volume + WIPE the workspace
  // (the project is gone), and remove this project's SSH users from the gateway
  // (which stays up — it is a platform singleton).
  await teardownDev(project.slug).catch(() => {});
  await removeProjectDevSshUsers(id).catch(() => {});
  // Drop any uploaded archive backing an "upload" source.
  await removeUploads(id).catch(() => {});
  mutate((d) => {
    d.projects = d.projects.filter((x) => x.id !== id);
    const depIds = d.deployments.filter((x) => x.projectId === id).map((x) => x.id);
    d.deployments = d.deployments.filter((x) => x.projectId !== id);
    for (const depId of depIds) delete d.logs[depId];
    d.envVars = d.envVars.filter((x) => x.projectId !== id);
    d.domains = d.domains.filter((x) => x.projectId !== id);
  });
  recordActivity("project", `Deleted project ${project.name}`, user.name, null);
}
