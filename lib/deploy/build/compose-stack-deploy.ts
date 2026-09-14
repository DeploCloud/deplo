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
import { tryAgent } from "./build-attempt";
import { appEnv, appEnvKeys, type PreviewEnvContext } from "./deploy-env";
import {
  commitOutcome,
  log,
  settleMove,
  sweepAfterDeploy,
  type DeployTarget,
} from "./deployment-state";

// ComposeStackApp is the app a compose-stack deploy needs: its source, its placement and
// the extras baked into every service.
export interface ComposeStackApp {
  id: string;
  teamId: string;
  environmentId?: string | null;
  // The host it runs on: a network lives on one machine, so a name is only contested
  // by a neighbour that is on the same one.
  serverId: string;
  name: string;
  slug: string;
  compose: string | null;
  composeUpArgs?: string | null;
  mounts?: { filePath: string; content: string }[] | null;
  resources?: ResourceLimits | null;
  volumes?: VolumeMount[] | null;
}

// ComposeStackOpts is one compose-stack deploy, from its key to where its state is written.
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
  // Every routable domain (the SOLE source of compose routing): each is one Traefik router
  // to its named compose service. Empty => built and run, but unrouted.
  domainRoutes: RoutableDomain[];
  environment: DeploymentEnvironment;
  started: number;
  forceRecreate: boolean;
}

// composeFilesDir is where a stack reads its mounts. `buildComposeStack` bakes it into the
// rendered YAML, so it MUST be the same on whichever host runs the stack.
export function composeFilesDir(deployKey: string): string {
  return stackFilesDir(deployKey);
}

// takenNamesForApp is what the neighbours on this app's network already answer to. A service
// of ours whose name is taken stays on the stack's private network instead of round-robining
// with theirs - which is how an app ended up querying another app's database.
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

// prepareComposeStack renders the app's own compose stack to deployable YAML.
async function prepareComposeStack(opts: ComposeStackOpts): Promise<{
  stackYaml: string;
  filesDir: string;
}> {
  const { project, name, deployKey, trackingId, domainRoutes } = opts;

  // A multi-domain template's extra hostnames are registered ONCE at app creation, NOT
  // here: a deploy never creates domain rows, so a deleted one is never resurrected.
  const filesDir = composeFilesDir(deployKey);
  const basicAuthUsers = await basicAuthUsersValue(project.id);
  // The settings env-var NAMES injected into every service as bare `- KEY` pass-throughs -
  // the value rides the env-file the agent writes, so no secret lands in the rendered YAML.
  const envKeys = await appEnvKeys(project.id, opts.environment, {
    preview: opts.preview,
  });
  const takenNames = await takenNamesForApp(project, project.id);
  const stackYaml = buildComposeStack({
    compose: project.compose ?? "",
    name,
    deployKey,
    takenNames,
    // A route the render could not wire is said out loud, or the deploy goes green with a
    // hostname that answers nothing and no line anywhere.
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
    // A preview is sealed in a network of its own; everything else joins its
    // Environment's (or its team's, when it has no Environment).
    network: deployNetwork(project, opts.preview ? deployKey : null),
  });
  return { stackYaml, filesDir };
}

// finishComposeStack applies the terminal status of a compose-stack deploy.
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
  // commitOutcome honors a "Stop build" pressed while the stack came up: its CAS keeps the
  // row `canceled`, and the follow-up logs run ONLY when the outcome actually applied.
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
      // Production only: a preview must not consume the marker or tear down the old host.
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

// deployComposeStackViaAgent deploys a multi-service compose stack through the owning
// server's agent (the host running Deplo included).
export async function deployComposeStackViaAgent(
  opts: ComposeStackOpts & { serverId: string },
): Promise<void> {
  const { depId, project, deployKey, serverId } = opts;

  // A multi-service stack is its own source kind: gate on the advertised capability and
  // fail with an actionable message instead.
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
    // A compose stack has no single image_ref (each service brings its own); the agent
    // neither builds nor pulls one.
    imageRef: "",
    composeYaml: stackYaml,
    network: deployNetwork(project, opts.preview ? deployKey : null),
    env,
    // A fork's code is a stranger's: it gets no config file of the app's either.
    plan: {
      kind: "compose",
      mounts: opts.preview?.isFork ? [] : (project.mounts ?? []),
    },
    // A multi-service stack may pull several images before any service reports running.
    readyTimeoutMs: 90_000,
    forceRecreate: opts.forceRecreate,
  });

  // tryAgent already logged the failure reason / unreachable-agent message.
  await finishComposeStack(opts, outcome === "agent");
}
