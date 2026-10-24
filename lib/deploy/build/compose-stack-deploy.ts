import { appTraefikOverrides } from "../../data/apps/traefik-labels";
import "server-only";

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
import type { AgentBuildPlan } from "../agent-deploy";
import { detectDefaultApp } from "../compose-lint/routing";
import {
  recordSourceCompose,
  routeDomainsToService,
} from "../../data/apps/build-outcome";
import { tryAgent } from "./build-attempt";
import { readyCheckFor } from "./ready-check";
import {
  anchorSourcePaths,
  prepareSourceCompose,
  sourceComposeDir,
} from "./source-compose";
import { appEnv, appEnvKeys, type PreviewEnvContext } from "./deploy-env";
import {
  commitOutcome,
  log,
  settleMove,
  sweepAfterDeploy,
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
  composeUpArgs?: string | null;
  mounts?: { filePath: string; content: string }[] | null;
  resources?: ResourceLimits | null;
  volumes?: VolumeMount[] | null;
}

export interface ComposeStackOpts {
  depId: string;
  // Set for a stack read from the app's own source: its paths live in the agent's working copy.
  sourceDir?: string;
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

  const filesDir = opts.sourceDir ?? composeFilesDir(deployKey);
  const basicAuthUsers = await basicAuthUsersValue(project.id);
  const envKeys = await appEnvKeys(project.id, opts.environment, {
    preview: opts.preview,
  });
  const takenNames = await takenNamesForApp(project, project.id);
  const stackYaml = buildComposeStack({
    ...(await appTraefikOverrides(project.id, Boolean(opts.preview))),
    compose: opts.sourceDir
      ? anchorSourcePaths(project.compose ?? "", opts.sourceDir)
      : (project.compose ?? ""),
    name,
    deployKey,
    takenNames,
    onWarn: (message) => log(opts.depId, "warn", message),
    stripPublishedPorts: Boolean(opts.preview),
    appId: project.id,
    trackingId,
    domainRoutes,
    filesDir,
    basicAuthUsers,
    envKeys,
    resources: project.resources,
    volumes: project.volumes,
    network: deployNetwork(project, opts.preview ? deployKey : null),
  });
  return { stackYaml, filesDir };
}

// `failure` is logged only when nothing else said why: the agent's own reason is already in the log.
async function finishComposeStack(
  opts: ComposeStackOpts & { serverId: string },
  running: boolean,
  failure: string | null = "Stack did not reach a running state",
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
      sweepAfterDeploy(depId, opts.serverId);
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
      if (failure) log(depId, "error", failure);
  }
}

export async function deployComposeStackViaAgent(
  opts: ComposeStackOpts & { serverId: string },
): Promise<void> {
  const { depId, project, deployKey, serverId } = opts;

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

  const { outcome, error } = await tryAgent({
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
      mounts: opts.preview?.isFork ? [] : (project.mounts ?? []),
    },
    readyTimeoutMs: 90_000,
    ready: readyCheckFor({
      routes: opts.domainRoutes,
      stack: true,
      compose: project.compose,
    }),
    forceRecreate: opts.forceRecreate,
  });

  await finishComposeStack(opts, outcome === "agent", error ? null : undefined);
}

// The second leg of a stack read from the source: the agent already read the file at this commit.
export async function deploySourceComposeStack(
  opts: ComposeStackOpts & {
    serverId: string;
    rawCompose: string;
    composeFile: string;
    source: Extract<AgentBuildPlan, { kind: "source-compose" }>["source"];
    subdir: string;
    tag: string;
  },
): Promise<{ deployed: boolean; observedPort?: number; service?: string }> {
  const { depId, project, deployKey, serverId } = opts;
  log(
    depId,
    "info",
    `Deploying ${opts.composeFile} from the repository as a stack`,
  );
  let stored: string;
  try {
    const prepared = prepareSourceCompose(opts.rawCompose, {
      deployKey,
      tag: opts.tag,
    });
    for (const note of prepared.notes) log(depId, "info", note);
    stored = prepared.yaml;
  } catch (e) {
    await finishComposeStack(
      opts,
      false,
      e instanceof Error ? e.message : String(e),
    );
    return { deployed: false };
  }
  if (!opts.preview) await recordSourceCompose(project.id, stored);
  const primary = detectDefaultApp(stored);
  let routes = opts.domainRoutes;
  if (primary) {
    if (!opts.preview)
      await routeDomainsToService(project.id, primary.service, primary.port);
    routes = routes.map((r) =>
      r.service
        ? r
        : { ...r, service: primary.service, port: r.port ?? primary.port },
    );
  } else if (routes.length > 0) {
    log(
      depId,
      "warn",
      "No service in the compose file lists a port (`ports:` or `expose:`), so its domain answers nothing. " +
        'Add `expose: ["3000"]` to the service that serves the app.',
    );
  }
  const stackOpts = {
    ...opts,
    project: { ...project, compose: stored },
    domainRoutes: routes,
    domains: routes.map((r) => r.name),
    sourceDir: sourceComposeDir(
      deployKey,
      opts.source.kind === "git" ? opts.subdir : "",
    ),
  };
  const { stackYaml } = await prepareComposeStack(stackOpts);
  const env = await appEnv(project.id, opts.environment, {
    preview: opts.preview,
  });
  const attempt = await tryAgent({
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
      kind: "source-compose",
      source: opts.source,
      composeFile: opts.composeFile,
    },
    ready: readyCheckFor({ routes, stack: true }),
    agentDeployId: `${depId}-stack`,
    forceRecreate: opts.forceRecreate,
  });
  await finishComposeStack(
    stackOpts,
    attempt.outcome === "agent",
    attempt.error ? null : undefined,
  );
  const service = routes[0]?.service ?? undefined;
  return {
    deployed: attempt.outcome === "agent",
    observedPort: attempt.observedPort,
    service,
  };
}
