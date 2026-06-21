import "server-only";

import { read, mutate } from "../store";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { startDeployment, destroyStack } from "../deploy/build";
import type { Deployment, DeploymentEnvironment, LogLine } from "../types";

export async function listDeployments(filter?: {
  projectId?: string;
  environment?: DeploymentEnvironment;
  status?: Deployment["status"];
}): Promise<(Deployment & { projectName: string; projectSlug: string })[]> {
  const teamId = await requireActiveTeamId();
  const d = read();
  const teamProjects = new Map(
    d.projects.filter((p) => p.teamId === teamId).map((p) => [p.id, p]),
  );
  return d.deployments
    .filter((x) => teamProjects.has(x.projectId))
    .filter((x) => !filter?.projectId || x.projectId === filter.projectId)
    .filter((x) => !filter?.environment || x.environment === filter.environment)
    .filter((x) => !filter?.status || x.status === filter.status)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((x) => {
      const p = teamProjects.get(x.projectId);
      return { ...x, projectName: p?.name ?? "", projectSlug: p?.slug ?? "" };
    });
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const teamId = await requireActiveTeamId();
  const dep = read().deployments.find((x) => x.id === id);
  if (!dep) return null;
  const inTeam = read().projects.some(
    (p) => p.id === dep.projectId && p.teamId === teamId,
  );
  return inTeam ? dep : null;
}

export async function getLogs(deploymentId: string): Promise<LogLine[]> {
  const teamId = await requireActiveTeamId();
  const dep = read().deployments.find((x) => x.id === deploymentId);
  if (!dep) return [];
  const inTeam = read().projects.some(
    (p) => p.id === dep.projectId && p.teamId === teamId,
  );
  if (!inTeam) return [];
  return read().logs[deploymentId] || [];
}

/** Trigger a fresh production build + deploy of the latest commit. */
export async function redeploy(projectId: string): Promise<Deployment> {
  const { membership } = await requireCapability("deploy");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const project = read().projects.find(
    (x) => x.id === projectId && x.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");
  const depId = startDeployment(projectId, {
    environment: "production",
    creator: user.name,
    commitMessage: "Redeploy of latest commit",
  });
  return read().deployments.find((x) => x.id === depId)!;
}

export async function cancelDeployment(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const dep = read().deployments.find((x) => x.id === id);
  if (!dep) throw new Error("Deployment not found");
  const inTeam = read().projects.some(
    (p) => p.id === dep.projectId && p.teamId === membership.teamId,
  );
  if (!inTeam) throw new Error("Deployment not found");
  mutate((d) => {
    const target = d.deployments.find((x) => x.id === id);
    if (!target) throw new Error("Deployment not found");
    if (target.status === "building" || target.status === "queued")
      target.status = "canceled";
  });
}

export async function promoteToProduction(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const existing = read().deployments.find((x) => x.id === id);
  if (!existing) throw new Error("Deployment not found");
  const inTeam = read().projects.some(
    (p) => p.id === existing.projectId && p.teamId === membership.teamId,
  );
  if (!inTeam) throw new Error("Deployment not found");
  mutate((d) => {
    const dep = d.deployments.find((x) => x.id === id);
    if (!dep) throw new Error("Deployment not found");
    dep.environment = "production";
    const p = d.projects.find((x) => x.id === dep.projectId);
    if (p) {
      p.latestDeploymentId = dep.id;
      p.productionUrl = dep.url;
      p.updatedAt = nowIso();
    }
  });
  recordActivity("deployment", `Promoted deployment to production`, user.name, null, membership.teamId);
}

/**
 * Tear down a project's running stack (used when deleting the project). Returns
 * `true` if the stack was destroyed, `false` if teardown failed — for a REMOTE
 * project that means an unreachable agent, in which case the delete proceeds
 * anyway (P6 spirit) and the caller warns that leftover containers on the remote
 * must be cleaned by hand. Never throws, so a dead remote never blocks a delete.
 */
export async function teardownProject(slug: string): Promise<boolean> {
  try {
    await destroyStack(slug);
    return true;
  } catch {
    return false;
  }
}
