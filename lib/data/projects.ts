import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import { buildConfigFor } from "../frameworks";
import type {
  BuildConfig,
  Deployment,
  DeploySource,
  FrameworkId,
  GitRepo,
  Project,
} from "../types";
import { newDeploymentInternal } from "./deployments";

export interface ProjectSummary extends Project {
  latestDeployment: Deployment | null;
  domainCount: number;
}

function summarize(p: Project): ProjectSummary {
  const d = read();
  const latest = p.latestDeploymentId
    ? d.deployments.find((x) => x.id === p.latestDeploymentId) || null
    : null;
  return {
    ...p,
    latestDeployment: latest,
    domainCount: d.domains.filter((x) => x.projectId === p.id).length,
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
  return read().projects.find((x) => x.id === id) || null;
}

export interface CreateProjectInput {
  name: string;
  framework: FrameworkId;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage?: string | null;
  serverId?: string;
  build?: Partial<BuildConfig>;
  autoDeploy?: boolean;
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
    build: buildConfigFor(input.framework, input.build),
    productionUrl: null,
    status: "queued",
    autoDeploy: input.autoDeploy ?? true,
    latestDeploymentId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  mutate((d) => d.projects.push(project));
  recordActivity("project", `Created project ${project.name}`, user.name, project.id);

  // Kick off the first deployment.
  const dep = newDeploymentInternal(project, {
    environment: "production",
    creator: user.name,
    commitMessage: input.repo ? "Initial import" : "Initial deployment",
  });
  mutate((d) => {
    const pr = d.projects.find((x) => x.id === project.id)!;
    pr.latestDeploymentId = dep.id;
    pr.status = "active";
    pr.productionUrl = dep.url;
  });

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
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Updated deploy source`, user.name, id);
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

export async function deleteProject(id: string): Promise<void> {
  const user = await assertUser();
  const project = read().projects.find((x) => x.id === id);
  if (!project) throw new Error("Project not found");
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
