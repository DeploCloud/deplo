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

/** The message every "this host has no agent yet" path produces - one story, one string. */
function notProvisionedMessage(serverName: string): string {
  return `${serverName} is not provisioned yet - its agent has never called home. Finish provisioning the server, then clean up Docker.`;
}

/** The executor's FIRST half: put the sweep on the record as `running`, before a
 *  single byte is asked of the host. */
async function beginCleanupRun(args: {
  serverId: string;
  serverName: string;
  actor: string;
  trigger: CleanupTrigger;
}): Promise<CleanupRunDTO> {
  const { serverId, serverName, actor, trigger } = args;
  const startedAt = nowIso();
  const runId = newId("dcr");

  // Short transaction, nothing else inside it: the agent is dialled later, outside.
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

/** The executor's SECOND half - the slow one: dial the host, then settle the run
 *  row that {@link beginCleanupRun} already wrote. NEVER throws. */
async function finishCleanupRun(args: {
  runId: string;
  serverId: string;
  serverName: string;
  actor: string;
  policy: CleanupPolicy;
  /** The team the activity row is attributed to; null for a tick, which has no active team. */
  teamId: string | null;
}): Promise<CleanupRunDTO> {
  const { runId, serverId, serverName, actor, policy, teamId } = args;

  let failure: string | null = null;
  let reclaimedBytes = 0;
  let items: CleanupRunItem[] = [];
  try {
    // The provisioning check lives HERE, after the run row exists, so a host whose
    // agent never called home leaves the same failed run as one that went offline,
    // and an actionable message rather than the dial's internals.
    const server = await getServerById(serverId);
    if (!server) throw new Error("Server not found");
    if (!server.agent?.certFingerprint)
      throw new Error(notProvisionedMessage(serverName));

    const resp = await runAgentCleanup(serverId, {
      scopes: policy.scopes.map((s) => SCOPE_TO_WIRE[s]),
      dryRun: false,
      minAgeHours: policy.minAgeHours,
      keepImagesPerApp: policy.keepImagesPerApp,
      // Per-app retention wins over the instance number wherever an app names one
      // - that is what keeps its rollbacks alive. See rollbackKeepBySlug.
      keepPerSlug: await rollbackKeepBySlug(serverId),
      // What the files, images and networks scopes judge a leftover against. An
      // empty list SKIPS the judgement agent-side, never "nothing is live".
      liveSlugs: await liveStackSlugs(),
      liveNetworks: await liveNetworkNames(),
    });
    // A per-scope `error`/`skipped` is NOT a run failure - the agent declines a scope it
    // cannot prove is safe and sweeps the rest. Only `ok:false` (the sweep could not
    // start at all) fails the run, and its partial results are still worth recording.
    items = toRunItems(resp.results ?? []);
    reclaimedBytes = Number(resp.reclaimedBytes ?? 0);
    if (!resp.ok) failure = resp.error || "the agent reported a failed cleanup";
  } catch (e) {
    failure =
      unreachableMessage(e) ?? (e instanceof Error ? e.message : String(e));
  }

  const finishedAt = nowIso();
  // TERMINAL transaction (short): the run's final status + its per-scope breakdown,
  // together - a run that reports bytes with no lines is a half-truth.
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

  // Best-effort: a failed trim must never turn a recorded sweep into a thrown one.
  try {
    await pruneCleanupRunHistory();
  } catch (e) {
    console.warn(
      `[cleanup] could not prune the run history: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Outside every transaction, fire-and-forget. A scheduled run passes teamId `null`
  // and recordActivity attributes it to the first team.
  await recordActivity(
    "cleanup",
    failure
      ? `Docker cleanup on ${serverName} failed: ${failure}`
      : `Docker cleanup on ${serverName} reclaimed ${formatBytes(reclaimedBytes)}`,
    actor,
    null,
    teamId,
  );
  // Only the failure is worth pushing: a sweep that reclaimed disk is good news
  // nobody needs woken for, and it is already in the trail above.
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

  // LAST, after the row, its items and the retention pass are all settled: whoever is
  // watching re-reads a consistent history.
  publishCleanupRunsChanged();
  return finished;
}

/** The manual sweeps still working their host, runId → the promise that settles them. */
const detachedSweeps = new Map<string, Promise<void>>();

/** Run the slow half detached: nobody awaits it, so the HTTP request that started
 *  the sweep has already answered. */
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
      // finishCleanupRun does not throw; reaching here means the STORE failed, which
      // leaves the row `running` for the boot reconcile to settle.
      console.error(
        `[cleanup] could not settle run ${runId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    })
    .finally(() => {
      detachedSweeps.delete(runId);
    });
  detachedSweeps.set(runId, tracked);
}

/** Test-only: wait for every detached sweep this process started. Production code
 *  must never call it. */
export async function __settleCleanupSweeps(): Promise<void> {
  while (detachedSweeps.size > 0) {
    await Promise.all([...detachedSweeps.values()]);
  }
}

/** START a sweep of one server NOW, with the instance policy's scopes. */
export async function runCleanupNow(serverId: string): Promise<CleanupRunDTO> {
  await requireInstanceAdmin();
  // Only to attribute the activity row - the sweep belongs to a host, not a team.
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  // UNSCOPED resolve, and correct now that the gate is instance-admin: this page
  // lists every host, and an instance admin already administers all of them.
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");
  // Same refusal the scheduler makes, and it has to be here too: this is the MANUAL
  // sweep, reachable from the API and from MCP, and reclaiming disk on a migration
  // source would delete the other platform's images while it is running on them.
  if (server.importOnly)
    throw new Error(
      `${server.name} is a migration source - Deplo does not reclaim disk on a ` +
        `machine it is only importing from.`,
    );

  const policy = await loadPolicy();
  // Fail fast rather than record a run that asks the agent for nothing: an empty scope
  // set is an ok response with zero bytes, indistinguishable from a sweep that worked.
  if (policy.scopes.length === 0) {
    throw new Error(
      "No cleanup scopes are selected - choose what to reclaim, then clean up",
    );
  }
  // Never stack sweeps: two concurrent `docker rmi` sweeps would race each other's
  // candidate lists.
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

/**
 * The session-free twin of {@link runCleanupNow}, for the scheduler tick. NEVER
 * throws - the failure is already on the run row, and one unreachable host must
 * not abort the rest of the tick.
 */
export async function runScheduledCleanup(
  serverId: string,
  serverName: string,
  policy: CleanupPolicy,
): Promise<void> {
  try {
    // A host whose agent has never called home has nothing to sweep, and recording a
    // failed run would put a red line in the history of an install still being set up.
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
    // Only a STORE failure reaches here (finishCleanupRun swallows the host's).
    console.warn(
      `[cleanup] scheduled sweep on ${serverName} could not be recorded: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
