import "server-only";

import {
  copyReleaseToMembers,
  isBuiltImage,
  membersHoldingImage,
} from "../../data/clusters/images";
import { planAppReplicas, type ReplicaPlan } from "../../data/clusters/spread";
import { getServerById } from "../../data/servers/roster";
import { teardownOrQueue } from "../../data/teardown-queue";
import type { ReadyCheck } from "../../agent/gen/agent";
import type { App } from "../../types/app";
import type { OverlapStacks } from "../overlap";
import { tryAgent } from "./build-attempt";
import { log } from "./deployment-state";

// The rest of a deploy for an App whose replicas run on several servers of its cluster (spec #176): the first
// server is deployed by the usual path, then each other one in turn, the old replicas serving until the new are ready.
// https://deplo.build/docs/operations/clusters/replicas-and-architectures#replicas-across-servers

type Member = ReplicaPlan["members"][number];

/** Where each replica of a cluster App runs, settled before anything is rendered; only its production deploys. */
export async function planDeployReplicas(
  project: App,
  dep: { environment: string },
  preview: unknown,
): Promise<ReplicaPlan | null> {
  return preview || dep.environment !== "production"
    ? null
    : planAppReplicas(project);
}

const replicaCount = (n: number) => (n === 1 ? "1 replica" : `${n} replicas`);

/**
 * Deploys the release on every member after the first, and removes the stack from members that run none
 * any more. A member that fails keeps its previous release, so the App goes on answering: false, and it stops there.
 */
export async function deployOtherMembers(opts: {
  depId: string;
  teamId: string;
  project: {
    id: string;
    name: string;
    deployKey: string;
    composeUpArgs: string | null;
  };
  plan: ReplicaPlan;
  imageRef: string;
  render: (member: Member) => Promise<{
    composeYaml: string;
    env: Record<string, string>;
    network: string;
    overlap?: OverlapStacks;
  }>;
  ready?: ReadyCheck;
  forceRecreate?: boolean;
}): Promise<boolean> {
  const { depId, project, plan, imageRef } = opts;
  const [first, ...others] = plan.members;
  if (!first) return true;
  const nameOf = async (id: string) =>
    (await getServerById(id))?.name ?? "a server";
  // A registry image is pulled by each member; one Deplo built is copied to it first.
  const built = isBuiltImage(imageRef);
  if (built && others.length > 0)
    await copyReleaseToMembers(project.id, imageRef, first.serverId);
  const holding = built ? await membersHoldingImage(project.id, imageRef) : [];
  const done = [await nameOf(first.serverId)];
  for (const m of others) {
    const name = await nameOf(m.serverId);
    const kept = `${name} kept the previous release, so ${project.name} is still answering: ${done.join(", ")} ${done.length === 1 ? "runs" : "run"} this one. Deploy again to finish.`;
    if (built && !holding.includes(m.serverId)) {
      log(depId, "error", `This release could not be copied to ${name}.`);
      log(depId, "error", kept);
      return false;
    }
    log(depId, "info", `Starting ${replicaCount(m.replicas)} on ${name}`);
    const rendered = await opts.render(m);
    const { outcome } = await tryAgent({
      depId,
      serverId: m.serverId,
      project,
      imageRef,
      composeYaml: rendered.composeYaml,
      network: rendered.network,
      env: rendered.env,
      plan: { kind: "image", image: imageRef, pull: !built },
      overlap: rendered.overlap,
      forceRecreate: opts.forceRecreate,
      ready: opts.ready,
    });
    if (outcome !== "agent") {
      log(depId, "error", kept);
      return false;
    }
    done.push(name);
  }
  for (const id of plan.dropped) {
    // Retried until that server answers: a copy left behind would go on taking visitors.
    const gone = await teardownOrQueue({
      serverId: id,
      deployKey: project.deployKey,
      projectLabel: project.id,
      label: project.name,
      teamId: opts.teamId,
    }).catch(() => false);
    const name = await nameOf(id);
    log(
      depId,
      gone ? "info" : "warn",
      gone
        ? `Removed the replicas ${name} no longer runs.`
        : `${name} did not answer, so the replicas it no longer runs are removed once it does.`,
    );
  }
  return true;
}
