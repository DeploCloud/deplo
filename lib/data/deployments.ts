import "server-only";

import { read, mutate } from "../store";
import { nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import { startDeployment, destroyStack } from "../deploy/build";
import type { Deployment, DeploymentEnvironment, LogLine } from "../types";

export async function listDeployments(filter?: {
  projectId?: string;
  environment?: DeploymentEnvironment;
  status?: Deployment["status"];
}): Promise<(Deployment & { projectName: string; projectSlug: string })[]> {
  await assertUser();
  const d = read();
  return d.deployments
    .filter((x) => !filter?.projectId || x.projectId === filter.projectId)
    .filter((x) => !filter?.environment || x.environment === filter.environment)
    .filter((x) => !filter?.status || x.status === filter.status)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((x) => {
      const p = d.projects.find((pp) => pp.id === x.projectId);
      return { ...x, projectName: p?.name ?? "", projectSlug: p?.slug ?? "" };
    });
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  await assertUser();
  return read().deployments.find((x) => x.id === id) || null;
}

export async function getLogs(deploymentId: string): Promise<LogLine[]> {
  await assertUser();
  return read().logs[deploymentId] || [];
}

/** Trigger a fresh production build + deploy of the latest commit. */
export async function redeploy(projectId: string): Promise<Deployment> {
  const user = await assertUser();
  const project = read().projects.find((x) => x.id === projectId);
  if (!project) throw new Error("Project not found");
  const depId = startDeployment(projectId, {
    environment: "production",
    creator: user.name,
    commitMessage: "Redeploy of latest commit",
  });
  return read().deployments.find((x) => x.id === depId)!;
}

export async function cancelDeployment(id: string): Promise<void> {
  await assertUser();
  mutate((d) => {
    const dep = d.deployments.find((x) => x.id === id);
    if (!dep) throw new Error("Deployment not found");
    if (dep.status === "building" || dep.status === "queued")
      dep.status = "canceled";
  });
}

export async function promoteToProduction(id: string): Promise<void> {
  const user = await assertUser();
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
  recordActivity("deployment", `Promoted deployment to production`, user.name, null);
}

/** Tear down a project's running stack (used when deleting the project). */
export async function teardownProject(slug: string): Promise<void> {
  await destroyStack(slug).catch(() => {});
}
