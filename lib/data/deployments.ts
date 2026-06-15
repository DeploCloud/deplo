import "server-only";

import { randomBytes } from "node:crypto";
import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import { FRAMEWORKS } from "../frameworks";
import type {
  Deployment,
  DeploymentEnvironment,
  LogLine,
  Project,
} from "../types";

function shortSha(): string {
  return randomBytes(4).toString("hex") + randomBytes(3).toString("hex");
}

function genLogs(project: Project): LogLine[] {
  const fw = FRAMEWORKS[project.framework];
  const now = Date.now();
  const t = (i: number) => new Date(now + i * 600).toISOString();
  const lines: [LogLine["level"], string][] = [
    [
      "command",
      `Cloning ${project.repo?.repo ?? "source"} (branch: ${project.repo?.branch ?? "main"})`,
    ],
    ["info", "Cloning completed"],
    ["command", `Detected framework: ${fw.name}`],
  ];
  if (fw.install) lines.push(["command", `Running install: \`${fw.install}\``]);
  lines.push(["info", "Dependencies installed"]);
  if (fw.build) lines.push(["command", `Running build: \`${fw.build}\``]);
  lines.push(["info", "✓ Build completed"]);
  lines.push(["command", "Building container image"]);
  lines.push(["info", "Image pushed to registry"]);
  lines.push(["command", "Configuring Traefik route + TLS"]);
  lines.push(["info", "Deployment ready"]);
  return lines.map(([level, text], i) => ({ ts: t(i), level, text }));
}

/** Internal helper used by project creation/redeploy. Assumes authorized. */
export function newDeploymentInternal(
  project: Project,
  opts: {
    environment: DeploymentEnvironment;
    creator: string;
    commitMessage?: string;
    branch?: string;
  },
): Deployment {
  const branch = opts.branch ?? project.repo?.branch ?? "main";
  const host = (
    project.productionUrl ?? `https://${project.slug}.deplo.app`
  ).replace(/^https?:\/\//, "");
  const url =
    opts.environment === "production"
      ? `https://${host}`
      : `https://${project.slug}-${newId("").slice(1, 7)}.deplo.app`;
  const dep: Deployment = {
    id: newId("dpl"),
    projectId: project.id,
    status: "ready",
    environment: opts.environment,
    commitSha: shortSha(),
    commitMessage: opts.commitMessage ?? "Redeploy",
    commitAuthor: opts.creator,
    branch,
    url,
    createdAt: nowIso(),
    readyAt: nowIso(),
    buildDurationMs: 30_000 + Math.floor(randomBytes(1)[0] * 100),
    creator: opts.creator,
  };
  mutate((d) => {
    d.deployments.push(dep);
    d.logs[dep.id] = genLogs(project);
  });
  recordActivity(
    "deployment",
    `Deployed ${project.name} to ${opts.environment}`,
    opts.creator,
    project.id,
  );
  return dep;
}

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

export async function redeploy(projectId: string): Promise<Deployment> {
  const user = await assertUser();
  const project = read().projects.find((x) => x.id === projectId);
  if (!project) throw new Error("Project not found");
  const dep = newDeploymentInternal(project, {
    environment: "production",
    creator: user.name,
    commitMessage: "Redeploy of latest commit",
  });
  mutate((d) => {
    const p = d.projects.find((x) => x.id === projectId)!;
    p.latestDeploymentId = dep.id;
    p.status = "active";
    p.productionUrl = dep.url;
    p.updatedAt = nowIso();
  });
  return dep;
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
  recordActivity(
    "deployment",
    `Promoted deployment to production`,
    user.name,
    null,
  );
}
