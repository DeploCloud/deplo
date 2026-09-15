import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  dockerCleanupRunItems,
  dockerCleanupRuns,
} from "../../db/schema/control-plane/docker-cleanup";
import { getCurrentUser } from "../../auth/current-user";
import { publishCleanupRunsChanged } from "../../graphql/pubsub";
import { newId, nowIso } from "../../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { recordActivity } from "../activity";
import { dispatchAlert, dispatchServerAlert } from "../../notify/dispatch";
import { getServerById } from "../servers/roster";
import { runAgentCleanup } from "../../infra/agent-client/docker-cleanup";
import { unreachableMessage } from "../../infra/server-health";
import { formatBytes } from "../../utils";
import {
  liveNetworkNames,
  liveStackSlugs,
  rollbackKeepBySlug,
} from "./live-inventory";
import { loadPolicy, type CleanupPolicy } from "./policy";
import {
  listServersWithCleanupRunning,
  pruneCleanupRunHistory,
  type CleanupRunDTO,
} from "./run-history";
import {
  orderItems,
  SCOPE_TO_WIRE,
  toRunItems,
  type CleanupRunItem,
  type CleanupRunStatus,
  type CleanupTrigger,
} from "./scopes";

function notProvisionedMessage(serverName: string): string {
  return `${serverName} is not provisioned yet - its agent has never called home. Finish provisioning the server, then clean up Docker.`;
}

async function beginCleanupRun(args: {
  serverId: string;
  serverName: string;
  actor: string;
  trigger: CleanupTrigger;
}): Promise<CleanupRunDTO> {
  const { serverId, serverName, actor, trigger } = args;
  const startedAt = nowIso();
  const runId = newId("dcr");

  await getDb().transaction(async (tx) => {
    await tx.insert(dockerCleanupRuns).values({
      id: runId,
      serverId,
      serverName,
      trigger,
      actor,
      status: "running",
      error: null,
      reclaimedBytes: 0,
      startedAt,
      finishedAt: null,
    });
  });
  publishCleanupRunsChanged();

  return {
    id: runId,
    serverId,
    serverName,
    trigger,
    actor,
    status: "running",
    error: null,
    reclaimedBytes: 0,
    startedAt,
    finishedAt: null,
    items: [],
  };
}

async function finishCleanupRun(args: {
  runId: string;
  serverId: string;
  serverName: string;
  actor: string;
  policy: CleanupPolicy;
  teamId: string | null;
}): Promise<CleanupRunDTO> {
  const { runId, serverId, serverName, actor, policy, teamId } = args;

  let failure: string | null = null;
  let reclaimedBytes = 0;
  let items: CleanupRunItem[] = [];
  try {
    const server = await getServerById(serverId);
    if (!server) throw new Error("Server not found");
    if (!server.agent?.certFingerprint)
      throw new Error(notProvisionedMessage(serverName));

    const resp = await runAgentCleanup(serverId, {
      scopes: policy.scopes.map((s) => SCOPE_TO_WIRE[s]),
      dryRun: false,
      minAgeHours: policy.minAgeHours,
      keepImagesPerApp: policy.keepImagesPerApp,
      keepPerSlug: await rollbackKeepBySlug(serverId),
      liveSlugs: await liveStackSlugs(),
      liveNetworks: await liveNetworkNames(),
    });
    items = toRunItems(resp.results ?? []);
    reclaimedBytes = Number(resp.reclaimedBytes ?? 0);
    if (!resp.ok) failure = resp.error || "the agent reported a failed cleanup";
  } catch (e) {
    failure =
      unreachableMessage(e) ?? (e instanceof Error ? e.message : String(e));
  }

  const finishedAt = nowIso();
  const finished = await getDb().transaction(
    async (tx): Promise<CleanupRunDTO> => {
      const updated = await tx
        .update(dockerCleanupRuns)
        .set({
          status: failure ? "failed" : "success",
          error: failure,
          reclaimedBytes,
          finishedAt,
        })
        .where(eq(dockerCleanupRuns.id, runId))
        .returning();
      if (items.length > 0) {
        await tx.insert(dockerCleanupRunItems).values(
          items.map((i) => ({
            runId,
            scope: i.scope,
            reclaimedBytes: i.reclaimedBytes,
            itemsRemoved: i.itemsRemoved,
            skipped: i.skipped,
            error: i.error,
          })),
        );
      }
      const row = updated[0]!;
      return {
        id: row.id,
        serverId: row.serverId,
        serverName: row.serverName,
        trigger: row.trigger as CleanupTrigger,
        actor: row.actor,
        status: row.status as CleanupRunStatus,
        error: row.error,
        reclaimedBytes: row.reclaimedBytes,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        items: orderItems(items),
      };
    },
  );

  try {
    await pruneCleanupRunHistory();
  } catch (e) {
    console.warn(
      `[cleanup] could not prune the run history: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  await recordActivity(
    "cleanup",
    failure
      ? `Docker cleanup on ${serverName} failed: ${failure}`
      : `Docker cleanup on ${serverName} reclaimed ${formatBytes(reclaimedBytes)}`,
    actor,
    null,
    teamId,
  );
  if (failure) {
    const alert = {
      key: "cleanup_failed" as const,
      title: `Cleanup failed on ${serverName}`,
      body: failure,
      path: "/settings/servers",
      dedupe: { id: `cleanup:${serverId}`, state: "failed" },
    };
    if (teamId) dispatchAlert({ ...alert, teamId });
    else dispatchServerAlert(serverId, alert);
  }

  publishCleanupRunsChanged();
  return finished;
}

const detachedSweeps = new Map<string, Promise<void>>();

function detachSweep(runId: string, work: Promise<CleanupRunDTO>): void {
  const tracked = work
    .then((run) => {
      if (run.status === "failed") {
        console.warn(
          `[cleanup] sweep on ${run.serverName} failed: ${run.error}`,
        );
      }
    })
    .catch((e) => {
      console.error(
        `[cleanup] could not settle run ${runId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    })
    .finally(() => {
      detachedSweeps.delete(runId);
    });
  detachedSweeps.set(runId, tracked);
}

export async function __settleCleanupSweeps(): Promise<void> {
  while (detachedSweeps.size > 0) {
    await Promise.all([...detachedSweeps.values()]);
  }
}

export async function runCleanupNow(serverId: string): Promise<CleanupRunDTO> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");
  if (server.importOnly)
    throw new Error(
      `${server.name} is a migration source - Deplo does not reclaim disk on a ` +
        `machine it is only importing from.`,
    );

  const policy = await loadPolicy();
  if (policy.scopes.length === 0) {
    throw new Error(
      "No cleanup scopes are selected - choose what to reclaim, then clean up",
    );
  }
  if ((await listServersWithCleanupRunning()).includes(serverId)) {
    throw new Error(`A cleanup is already running on ${server.name}`);
  }

  const run = await beginCleanupRun({
    serverId,
    serverName: server.name,
    actor: user.name,
    trigger: "manual",
  });
  detachSweep(
    run.id,
    finishCleanupRun({
      runId: run.id,
      serverId,
      serverName: server.name,
      actor: user.name,
      policy,
      teamId,
    }),
  );
  return run;
}

export async function runScheduledCleanup(
  serverId: string,
  serverName: string,
  policy: CleanupPolicy,
): Promise<void> {
  try {
    const server = await getServerById(serverId);
    if (!server?.agent?.certFingerprint) return;
    const run = await beginCleanupRun({
      serverId,
      serverName,
      actor: "Scheduler",
      trigger: "scheduled",
    });
    await finishCleanupRun({
      runId: run.id,
      serverId,
      serverName,
      actor: "Scheduler",
      policy,
      teamId: null,
    });
  } catch (e) {
    console.warn(
      `[cleanup] scheduled sweep on ${serverName} could not be recorded: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
