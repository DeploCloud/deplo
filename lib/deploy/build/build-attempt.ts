import "server-only";

import { eq } from "drizzle-orm";
import { withKeyedLock } from "../../data/keyed-mutex";
import { getServerById } from "../../data/servers/roster";
import { dropTeardown } from "../../data/teardown-queue";
import { copyImageBetween } from "../../data/volume-migration";
import { getDb } from "../../db/client";
import {
  apps as appsTable,
  appBuild as appBuildTable,
} from "../../db/schema/control-plane/apps";
import { connectAgent } from "../../infra/agent-client/connect";
import {
  AgentUnreachableError,
  AgentVolumeCopyUnsupportedError,
} from "../../infra/agent-client/errors";
import { agentPreflight } from "../../infra/agent-client/preflight";
import type { App } from "../../types/app";
import type { LogLine } from "../../types/deployment";
import { formatBytes } from "../../utils";
import {
  agentCapabilityForMethod,
  runAgentDeploy,
  AgentUnavailableError,
  type AgentBuildPlan,
} from "../agent-deploy";
import { resolveBuildPlan, buildPlanLines } from "../build-server";
import { parseComposeUpArgs } from "../compose-args";
import { warnCrossNetwork } from "./cross-network-warning";
import {
  commitOutcome,
  log,
  setDep,
  type DeployTarget,
} from "./deployment-state";

// noCacheForDeploy says whether this build reads the owning server's build cache, and
// the line the build log opens with when it does not.
export function noCacheForDeploy(build: {
  buildCache: boolean;
  buildCacheClearPending: boolean;
}): { noCache: boolean; reason: string } {
  if (build.buildCacheClearPending) {
    return {
      noCache: true,
      reason:
        "Build cache cleared - building from scratch, then caching again.",
    };
  }
  if (!build.buildCache) {
    return {
      noCache: true,
      reason: "Build cache is off for this app - building from scratch.",
    };
  }
  return { noCache: false, reason: "" };
}

// consumeCacheClear spends the one-shot "Clear build cache", so the NEXT deploy caches again.
export async function consumeCacheClear(appId: string): Promise<void> {
  await getDb()
    .update(appBuildTable)
    .set({ buildCacheClearPending: false })
    .where(eq(appBuildTable.appId, appId));
}

// AgentAttempt is the agent attempt's outcome plus any commit sha it resolved.
interface AgentAttempt {
  outcome: "agent" | "failed";
  commitSha: string;
}

// Only git/dockerfile can be split across a build server: a prebuilt `image` has nothing
// to build, and a `compose` stack has no single image to move.
function planBuilds(plan: AgentBuildPlan): boolean {
  return plan.kind === "git" || plan.kind === "dockerfile";
}

// resolveBuildServerFor names the host a deploy about to be queued will compile on, or
// null for "build where it runs". Choosing must never stop an app from shipping.
export async function resolveBuildServerFor(
  project: {
    teamId: string;
    serverId: string;
    buildServerId?: string | null;
    buildFallback: boolean;
  },
  deployServerId: string,
  depId: string,
): Promise<string | null> {
  try {
    const target = await getServerById(deployServerId);
    if (!target) return null;
    const plan = await resolveBuildPlan(
      {
        teamId: project.teamId,
        serverId: project.serverId,
        buildServerId: project.buildServerId ?? null,
        buildFallback: project.buildFallback,
      },
      target,
    );
    return plan.chain[0] ?? null;
  } catch (e) {
    console.error(`[deplo] build server lookup failed for ${depId}:`, e);
    return null;
  }
}

// agentIsDown covers BOTH classes of "that host did not answer": matching only one is how
// a fallback that exists for "the build server is down" ends up never firing for it.
function agentIsDown(e: unknown): boolean {
  return (
    e instanceof AgentUnavailableError || e instanceof AgentUnreachableError
  );
}

function agentDownReason(e: unknown): string {
  if (e instanceof AgentUnavailableError) {
    return e.message;
  }
  // A TRUST failure is not a dead host: the peer answered, it just is not the agent
  // Deplo pinned. "It did not answer" would send someone to check the one thing that is fine.
  if (e instanceof AgentUnreachableError && e.trust) {
    return "its certificate is not the one Deplo trusts - reissue its install command";
  }
  return "it did not answer";
}

// buildOnBuildServer is the build half of a split deploy: compile on the first build server
// that answers, then stream the image to the host that will run it.
async function buildOnBuildServer(opts: {
  depId: string;
  serverId: string;
  builders: { id: string; name: string }[];
  targetServerName?: string;
  localAllowed: boolean;
  project: { id: string; deployKey: string; composeUpArgs: string | null };
  imageRef: string;
  composeYaml: string;
  network: string;
  env: Record<string, string>;
  forkPreview?: boolean;
  plan: AgentBuildPlan;
  noCache?: boolean;
  sink: (level: LogLine["level"], text: string) => void;
}): Promise<{
  outcome: "built" | "fallback" | "failed";
  commitSha: string;
  builtOn?: string;
}> {
  const targetName = opts.targetServerName ?? "the app's server";

  let builder: { id: string; name: string } | null = null;
  let commitSha = "";
  for (const [i, candidate] of opts.builders.entries()) {
    try {
      const built = await runAgentDeploy({
        serverId: candidate.id,
        deployId: opts.depId,
        slug: opts.project.deployKey,
        appId: opts.project.id,
        imageRef: opts.imageRef,
        composeYaml: opts.composeYaml,
        network: opts.network,
        env: opts.env,
        plan: opts.plan,
        forkPreview: opts.forkPreview,
        noCache: opts.noCache,
        buildOnly: true,
        sink: { log: opts.sink },
      });
      if (!built.ready)
        return { outcome: "failed", commitSha: built.commitSha };
      commitSha = built.commitSha;
      builder = candidate;
      break;
    } catch (e) {
      // A host that did not answer is the whole reason the rest of the chain exists; a
      // build that RAN and failed is this app's own failure and stops here.
      if (!agentIsDown(e)) throw e;
      console.error(`[deplo] build server ${candidate.id} unavailable:`, e);
      const why = `${candidate.name} could not be reached (${agentDownReason(e)}).`;
      const next = opts.builders[i + 1];
      if (next) {
        opts.sink("warn", `${why} Building on ${next.name} instead.`);
        continue;
      }
      if (opts.localAllowed) {
        opts.sink("warn", `${why} Building on ${targetName} instead.`);
        return { outcome: "fallback", commitSha: "" };
      }
      opts.sink(
        "error",
        `${why} This app is set not to build on ${targetName}, so the running ` +
          `version was not touched.`,
      );
      return { outcome: "failed", commitSha: "" };
    }
  }
  if (!builder) return { outcome: "fallback", commitSha: "" };

  // The image exists on the builder and nowhere else, so from here a failure is a failure:
  // repeating the build on a host chosen for being small is what this path exists to avoid.
  try {
    const bytes = await relayBuiltImage(
      builder.id,
      opts.serverId,
      opts.imageRef,
    );
    opts.sink(
      "info",
      `Copied ${formatBytes(bytes)} from ${builder.name} to ${targetName}`,
    );
    return { outcome: "built", commitSha, builtOn: builder.id };
  } catch (e) {
    console.error(
      `[deplo] image copy ${builder.id} -> ${opts.serverId} failed:`,
      e,
    );
    // AgentVolumeCopyUnsupportedError's text is ours ("update the agent on the <side>
    // server"); anything else is a transport error whose text is not safe to show.
    const why =
      e instanceof AgentVolumeCopyUnsupportedError
        ? e.message
        : "the transfer did not complete";
    opts.sink(
      "error",
      `Could not copy the built image from ${builder.name} to ${targetName}: ${why}. ` +
        `The running version was not touched.`,
    );
    return { outcome: "failed", commitSha };
  }
}

// relayBuiltImage relays the image between two hosts THROUGH the control plane: agents are
// a star and cannot dial each other (the same path a cross-host volume copy takes).
async function relayBuiltImage(
  buildServerId: string,
  targetServerId: string,
  imageRef: string,
): Promise<number> {
  const source = await connectAgent(buildServerId);
  try {
    const dest = await connectAgent(targetServerId);
    try {
      return await copyImageBetween(source, dest, imageRef);
    } finally {
      dest.close();
    }
  } finally {
    source.close();
  }
}

// tryAgent renders nothing and decides nothing: it ships this deploy through the OWNING
// agent, optionally compiling it on a build server first.
export async function tryAgent(opts: {
  depId: string;
  serverId: string;
  project: { id: string; deployKey: string; composeUpArgs: string | null };
  imageRef: string;
  composeYaml: string;
  network: string;
  env: Record<string, string>;
  plan: AgentBuildPlan;
  // How long the agent waits for the stack to report running (ms). Defaults to 60s (the
  // single-image path); the compose path passes 90s - it may pull several images first.
  readyTimeoutMs?: number;
  noCache?: boolean;
  forceRecreate?: boolean;
  // The BUILD SERVERS this deploy may compile on, in order. Empty (the ordinary case)
  // builds and runs on the same host.
  builders?: { id: string; name: string }[];
  targetServerName?: string;
  localAllowed?: boolean;
  planLines?: { level: LogLine["level"]; text: string }[];
  forkPreview?: boolean;
}): Promise<AgentAttempt> {
  // Serialize the agent bring-up against deleteApp/deleteApps on the app's lifecycle lock.
  return withKeyedLock(`app-lifecycle:${opts.project.id}`, async () => {
    const stillExists = await getDb()
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(eq(appsTable.id, opts.project.id))
      .limit(1);
    if (stillExists.length === 0) {
      log(
        opts.depId,
        "error",
        "App was deleted during the build - deploy aborted.",
      );
      return { outcome: "failed", commitSha: "" };
    }
    // A teardown of this key queued on this host (a move that failed and rolled back) must
    // not fire on the stack about to be brought up here on purpose.
    await dropTeardown(opts.serverId, opts.project.deployKey);
    // A warning, never a refusal: the match is a heuristic and a false positive must not
    // stop a deploy.
    await warnCrossNetwork(
      opts.depId,
      opts.project.id,
      opts.network,
      opts.env,
      opts.composeYaml,
    );
    let plan = opts.plan;
    let builtCommitSha = "";
    try {
      const builders = (opts.builders ?? []).filter(
        (b) => b.id !== opts.serverId,
      );
      if (planBuilds(opts.plan)) {
        for (const line of opts.planLines ?? [])
          log(opts.depId, line.level, line.text);
        if (builders.length === 0 && opts.localAllowed === false)
          return { outcome: "failed", commitSha: "" };
      }
      if (builders.length > 0 && planBuilds(opts.plan)) {
        // Claimed BEFORE the build: the in-flight count behind `leastBusy` reads this
        // column, so a pick that stays null makes every concurrent deploy choose the same one.
        await setDep(opts.depId, { buildServerId: builders[0]!.id });
        const leg = await buildOnBuildServer({
          ...opts,
          builders,
          localAllowed: opts.localAllowed !== false,
          sink: (level: LogLine["level"], text: string) =>
            log(opts.depId, level, text),
        });
        if (leg.outcome === "failed")
          return { outcome: "failed", commitSha: leg.commitSha };
        if (leg.outcome === "built") {
          builtCommitSha = leg.commitSha;
          if (leg.builtOn)
            await setDep(opts.depId, { buildServerId: leg.builtOn });
          // The target now runs it exactly as a ROLLBACK does: a local tag, in no registry.
          plan = { kind: "image", image: opts.imageRef, pull: false };
        }
      }

      const { ready, commitSha } = await runAgentDeploy({
        serverId: opts.serverId,
        deployId: opts.depId,
        slug: opts.project.deployKey,
        appId: opts.project.id,
        imageRef: opts.imageRef,
        composeYaml: opts.composeYaml,
        network: opts.network,
        env: opts.env,
        plan,
        forkPreview: opts.forkPreview,
        readyTimeoutMs: opts.readyTimeoutMs ?? 60_000,
        noCache: opts.noCache,
        forceRecreate: opts.forceRecreate,
        composeUpArgs: parseComposeUpArgs(opts.project.composeUpArgs),
        sink: { log: (level, text) => log(opts.depId, level, text) },
      });
      // A release of an already-built image reports no commit - the build did, one host ago.
      return {
        outcome: ready ? "agent" : "failed",
        commitSha: commitSha || builtCommitSha,
      };
    } catch (e) {
      if (agentIsDown(e)) {
        // No in-process build path to fall back to: an unreachable agent is a clear deploy
        // failure, never a hung one.
        console.error(`[deplo] agent ${opts.serverId} unavailable:`, e);
        log(opts.depId, "error", `Agent unavailable: ${agentDownReason(e)}`);
        return { outcome: "failed", commitSha: "" };
      }
      throw e;
    }
  });
}

// resolveBuildServerOpts resolves the chain of hosts this deploy may compile on, plus the
// lines explaining the choice. Re-resolved rather than read off the row: the row holds ONE
// host, and a build that cannot happen there has to know what comes next.
export async function resolveBuildServerOpts(
  project: App,
  serverId: string,
  rollback: boolean,
): Promise<{
  builders: { id: string; name: string }[];
  localAllowed: boolean;
  targetServerName: string;
  planLines: { level: LogLine["level"]; text: string }[];
}> {
  const targetServer = await getServerById(serverId);
  const targetServerName = targetServer?.name ?? "the app's server";
  const buildPlan =
    targetServer && !rollback
      ? await resolveBuildPlan(project, targetServer)
      : { chain: [], local: true, missed: null };
  const builders = await Promise.all(
    buildPlan.chain.map(async (id) => ({
      id,
      name: (await getServerById(id))?.name ?? id,
    })),
  );
  return {
    builders,
    localAllowed: buildPlan.local,
    targetServerName,
    planLines: buildPlanLines(
      buildPlan,
      (id) => builders.find((b) => b.id === id)?.name ?? id,
      targetServerName,
    ),
  };
}

// assertBuildMethodCapability gates the build method on the advertised agent capability,
// failing the deploy with an actionable "update the agent" message. False ⇒ stop here.
export async function assertBuildMethodCapability(opts: {
  depId: string;
  target: DeployTarget;
  build: App["build"];
  rollback: boolean;
  onBuildServer: boolean;
  builders: { id: string; name: string }[];
  serverId: string;
  started: number;
}): Promise<boolean> {
  const { depId, target, builders, started } = opts;
  const requiredCapability = opts.rollback
    ? null
    : agentCapabilityForMethod(opts.build);
  // The capability belongs to whichever host actually RUNS the builder: gating the target
  // on a method it will never invoke would refuse a deploy for the wrong host's age.
  // ponytail: only the head of the chain is gated; a fallback host too old for the
  // method fails its build instead. Gate each one if the fleet ever runs mixed.
  const capServerId = builders[0]?.id ?? opts.serverId;
  if (!requiredCapability) return true;
  try {
    const hello = await agentPreflight(capServerId);
    if (!hello.capabilities.includes(requiredCapability)) {
      log(
        depId,
        "error",
        `${opts.onBuildServer ? "The build server's" : "This server's"} agent is too ` +
          `old to run the ${opts.build.buildMethod} build method. Update the agent ` +
          `(reissue the install command from the server's actions menu).`,
      );
      await commitOutcome(
        depId,
        target,
        { status: "error", buildDurationMs: Date.now() - started },
        { status: "error" },
      );
      return false;
    }
  } catch (e) {
    // An unreachable BUILD SERVER is not decided here.
    if (!builders[0]) {
      log(
        depId,
        "error",
        `Agent unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
      await commitOutcome(
        depId,
        target,
        { status: "error", buildDurationMs: Date.now() - started },
        { status: "error" },
      );
      return false;
    }
  }
  return true;
}
