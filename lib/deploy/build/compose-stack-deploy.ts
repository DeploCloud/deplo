import "server-only";
import { readGitCompose } from "../../apps/repo-compose";
import { assertRepositoryComposeSavable } from "../../data/apps/source-guards";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { eq } from "drizzle-orm";
import type { GitRepo } from "../../types/build";
import type { GitSource } from "../../agent/gen/agent";

import { basicAuthUsersValue } from "../../data/basic-auth";
import type { RoutableDomain } from "../../data/domains/routes";
import { namesTakenOnNetwork } from "../../data/name-clash";
import { nowIso } from "../../ids";
import { agentPreflight } from "../../infra/agent-client/preflight";
import type { ResourceLimits, VolumeMount } from "../../types/container";
import type { DeploymentEnvironment } from "../../types/deployment";
import { buildComposeStack } from "../compose-stack/render";
import { stackFilesDir } from "../deploy-key";
import { deployNetwork } from "../network";
import { tryAgent } from "./build-attempt";
import { appEnv, appEnvKeys, type PreviewEnvContext } from "./deploy-env";
import {
  commitOutcome,
  log,
  settleMove,
  sweepAfterDeploy,
  setDep,
  type DeployTarget,
} from "./deployment-state";

export interface ComposeStackApp {
  id: string;
  teamId: string;
  environmentId?: string | null;
  serverId: string;
  name: string;
  slug: string;
  compose: string | null;
  composePath?: string | null;
  repo?: GitRepo | null;
  build?: { rootDirectory: string };
  buildServerId?: string | null;
  composeUpArgs?: string | null;
  mounts?: { filePath: string; content: string }[] | null;
  resources?: ResourceLimits | null;
  volumes?: VolumeMount[] | null;
}

export interface ComposeStackOpts {
  depId: string;
  project: ComposeStackApp;
  name: string;
  deployKey: string;
  trackingId: string;
  target: DeployTarget;
  preview: PreviewEnvContext | null;
  domain: string;
  domains: string[];
  domainRoutes: RoutableDomain[];
  environment: DeploymentEnvironment;
  started: number;
  forceRecreate: boolean;
  repository?: { branch: string; commit: string; publicCloneUrl?: string };
}

export function composeFilesDir(deployKey: string): string {
  return stackFilesDir(deployKey);
}

export async function takenNamesForApp(
  project: { teamId: string; environmentId?: string | null; serverId: string },
  appId: string,
): Promise<string[]> {
  return [
    ...(await namesTakenOnNetwork(
      {
        teamId: project.teamId,
        environmentId: project.environmentId ?? null,
        serverId: project.serverId,
      },
      appId,
    )),
  ];
}

async function prepareComposeStack(opts: ComposeStackOpts): Promise<{
  stackYaml: string;
  filesDir: string;
}> {
  const { project, name, deployKey, trackingId, domainRoutes } = opts;

  const filesDir = composeFilesDir(deployKey);
  const basicAuthUsers = await basicAuthUsersValue(project.id);
  const envKeys = await appEnvKeys(project.id, opts.environment, {
    preview: opts.preview,
  });
  const takenNames = await takenNamesForApp(project, project.id);
  const stackYaml = buildComposeStack({
    compose: project.compose ?? "",
    name,
    deployKey,
    takenNames,
    onWarn: (message) => log(opts.depId, "warn", message),
    stripPublishedPorts: Boolean(opts.preview),
    appId: project.id,
    trackingId,
    domainRoutes,
    filesDir: project.composePath ? undefined : filesDir,
    basicAuthUsers,
    envKeys,
    resources: project.resources,
    volumes: project.volumes,
    network: deployNetwork(project, opts.preview ? deployKey : null),
  });
  return { stackYaml, filesDir };
}

async function finishComposeStack(
  opts: ComposeStackOpts & { serverId: string },
  running: boolean,
): Promise<void> {
  const { depId, project, domain, environment, started, target } = opts;
  const buildDurationMs = Date.now() - started;
  const domainRoute = opts.domainRoutes.find((r) => r.name === domain);
  const url = domain
    ? `${domainRoute && !domainRoute.tls ? "http" : "https"}://${domain}`
    : "";
  if (running) {
    const applied = await commitOutcome(
      depId,
      target,
      { status: "ready", readyAt: nowIso(), buildDurationMs },
      {
        status: "active",
        ...(environment === "production" ? { productionUrl: url || null } : {}),
      },
    );
    if (applied) {
      log(
        depId,
        "success",
        url
          ? `Deployment ready at ${url}`
          : "Deployment ready (no domain - add one to route traffic)",
      );
      if (environment === "production") {
        await settleMove(depId, project.id, opts.serverId);
      }
      await sweepAfterDeploy(depId, opts.serverId);
    }
  } else {
    if (
      await commitOutcome(
        depId,
        target,
        { status: "error", buildDurationMs },
        { status: "error" },
      )
    )
      log(depId, "error", "Stack did not reach a running state");
  }
}

export async function deployComposeStackViaAgent(
  opts: ComposeStackOpts & { serverId: string },
): Promise<void> {
  const { depId, project, deployKey, serverId } = opts;
  let git: GitSource | undefined;
  if (project.composePath) {
    if (!project.repo || !opts.repository)
      throw new Error("Repository Compose source is missing");
    if (project.buildServerId)
      throw new Error("Repository Compose builds run on the deployment server");
    const result = await readGitCompose(
      serverId,
      project.repo,
      project.composePath,
      project.build?.rootDirectory ?? "",
      opts.repository.branch,
      opts.repository.commit,
      opts.repository.publicCloneUrl,
    );
    const [owner] = await getDb()
      .select({
        createdBy: appsTable.createdByUserId,
        approvedBy: appsTable.hostReachBy,
      })
      .from(appsTable)
      .where(eq(appsTable.id, project.id))
      .limit(1);
    await assertRepositoryComposeSavable(
      result.compose,
      opts.preview?.isFork
        ? null
        : (owner?.approvedBy ?? owner?.createdBy ?? null),
    );
    git = result.git;
    opts = { ...opts, project: { ...project, compose: result.compose } };
    if (!opts.preview)
      await getDb()
        .update(appsTable)
        .set({ compose: result.compose })
        .where(eq(appsTable.id, project.id));
    await setDep(depId, { commitSha: result.commitSha });
  }

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
  const env = await appEnv(project.id, opts.environment, {
    preview: opts.preview,
  });

  const { outcome } = await tryAgent({
    depId,
    serverId,
    project: {
      id: project.id,
      deployKey,
      composeUpArgs: project.composeUpArgs ?? null,
    },
    imageRef: "",
    composeYaml: stackYaml,
    network: deployNetwork(project, opts.preview ? deployKey : null),
    env,
    plan: {
      kind: "compose",
      git,
      composePath: project.composePath ?? undefined,
      mounts: opts.preview?.isFork ? [] : (project.mounts ?? []),
    },
    readyTimeoutMs: 90_000,
    forceRecreate: opts.forceRecreate,
    forkPreview: Boolean(opts.preview?.isFork),
  });

  await finishComposeStack(opts, outcome === "agent");
}
