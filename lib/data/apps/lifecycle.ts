import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { startDeployment } from "../../deploy/build/deploy-start";
import { rerouteApp } from "../../deploy/build/reroute";
import {
  startContainer,
  stopContainer,
} from "../../deploy/build/stack-lifecycle";
import { appSourceInTeam, loadAppGraph } from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import { assertDataCopyIntact } from "../data-copy";
import { recordActivity } from "../activity";
import { publishAppChanged } from "../../graphql/pubsub";
import type { AppStatus, DeploySource } from "../../types/app";

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// setAppStatus is NOT gated and NOT team-scoped: every caller resolved the app through a capability
// check already, and the write is unconditional so it cannot lose a race with a deploy.
export async function setAppStatus(
  id: string,
  status: AppStatus,
): Promise<void> {
  await getDb()
    .update(appsTable)
    .set({ status, updatedAt: nowIso() })
    .where(eq(appsTable.id, id));
  publishAppChanged(id);
}

export async function stopApp(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "control_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");

  // Persisted BEFORE the (up to 60s) stop, so the transition is visible to every client and survives a reload.
  await setAppStatus(id, "stopping");
  await recordActivity("app", `Stopping ${project.name}`, user.name, id);
  try {
    await stopContainer(project.slug);
  } catch (e) {
    // A stop failure must FAIL CLEARLY: the container may still be running, so settling to "idle" would lie.
    await setAppStatus(id, "active");
    throw new Error(
      `The stack on ${project.name}'s server was not stopped: ${errMsg(e)}`,
    );
  }
  await setAppStatus(id, "idle");
}

export async function startApp(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "control_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");

  // Start is a second door onto the same volumes and skips the deploy pipeline, so it needs the same refusal.
  assertDataCopyIntact(project.name, project.dataCopyError);
  await setAppStatus(id, "active");
  try {
    // `compose start` starts what it FINDS, on the network it was created with, so a stack stopped before a
    // move would come back on the old one. Re-rendering brings it up on the right network in one step.
    if ((await rerouteApp(id)) !== "rerouted")
      await startContainer(project.slug);
  } catch (e) {
    await setAppStatus(id, "idle");
    throw new Error(
      `The stack on ${project.name}'s server was not started: ${errMsg(e)}`,
    );
  }
  await recordActivity("app", `Started ${project.name}`, user.name, id);
}

const REBUILD_MESSAGE: Record<DeploySource, string> = {
  github: "Rebuild container",
  git: "Rebuild container",
  upload: "Rebuild container",
  "docker-image": "Pull and recreate the container",
  compose: "Recreate the stack's containers",
};

// Force-recreate: `compose up -d` compares its own config hash and would otherwise finish green with the same container.
export async function rebuildApp(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "deploy_apps");
  const user = (await getCurrentUser())!;
  const source = await appSourceInTeam(id, membership.teamId);
  if (!source) throw new Error("App not found");
  await startDeployment(id, {
    environment: "production",
    creator: user.name,
    commitMessage: REBUILD_MESSAGE[source],
    forceRecreate: true,
  });
}
