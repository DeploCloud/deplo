import "server-only";

import { count, eq, inArray, sql } from "drizzle-orm";

import { resolveAgentRelease } from "../../agent/release";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterDnsZones,
  clusterMembers,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { isDeploHostServer } from "../../deploy/domains";
import { selfUpdateServerAgent } from "../../infra/agent-client/agent-lifecycle";
import { openAgent } from "../../infra/agent-client/connect";
import { nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import { dispatchServerAlert } from "../../notify/dispatch";
import {
  AGENT_MIN_VERSION,
  AGENT_VERSION,
  DEPLO_VERSION,
  agentReach,
  agentUpdateAvailable,
  reportedAgentVersion,
  updateReaches,
  type AgentReach,
} from "../../version";
import type { Server } from "../../types/server";
import { recordActivity } from "../activity";
import { SETTINGS_ID } from "../instance-settings/settings-store";
import { settleUpdateLogAtBoot } from "../update-log";
import { markServerSeen } from "./agent-handshake";
import {
  type AgentUpdateDTO,
  type AgentUpdateFailure,
  type AgentUpdateRow,
  STALE_RUNNING_MS,
  claimAgentUpdate,
  clearAgentUpdate,
  dropStaleAgentUpdates,
  getAgentUpdate,
  listAgentUpdates,
  recordAgentUpdateFailure,
  toAgentUpdateDTO,
} from "./agent-update-state";
import { listAllServers } from "./roster";
import { instanceFrozen } from "../deplo-move/freeze";
import { readLeaderSnapshot } from "../clusters/leader-sync";
import { handLeadersOff } from "../clusters/leader-move";
import { getClusterById } from "../clusters/roster";

const TICK_MS = 60_000;
const FIRST_RUN_MS = 20_000;
export const rolloutTiming = {
  // Longer than the 30 s an agent gives a new binary before it goes back to the one before (ADR-0043).
  confirmTries: 30,
  confirmDelayMs: 1500,
  nameServerMarginMs: 5000,
  // A server is held this long on the new version, its renewals included, before the next one updates.
  holdMs: 60_000,
  holdEveryMs: 5000,
  holdWait: (ms: number) => sleep(ms),
  wait: (ms: number) => sleep(ms),
};

// A name server just updated stays silent until it hears its cluster (ADR-0049): the next waits it out.
async function nameServerSettleMs(serverId: string): Promise<number> {
  const rows = await getDb()
    .select({ drop: clustersTable.dnsDropAfter })
    .from(clusterMembers)
    .innerJoin(clustersTable, eq(clustersTable.id, clusterMembers.clusterId))
    .innerJoin(clusterDnsZones, eq(clusterDnsZones.clusterId, clustersTable.id))
    .where(eq(clusterMembers.serverId, serverId));
  if (rows.length === 0) return 0;
  return (
    Math.max(...rows.map((r) => r.drop)) * 1000 +
    rolloutTiming.nameServerMarginMs
  );
}

export interface FleetAgent {
  id: string;
  name: string;
  version: string | null;
  usable: boolean;
  reach: AgentReach;
  update: AgentUpdateDTO | null;
}

export interface FleetAgentStatus {
  expected: string;
  minimum: string;
  total: number;
  behind: FleetAgent[];
  updating: boolean;
  // The server whose update did not come back: every other one waits for it.
  pausedBy: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function rolloutActor(): Promise<string | null> {
  const rows = await getDb()
    .select({ actor: instanceSettings.agentRolloutBy })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  return rows[0]?.actor ?? null;
}

async function writeRolloutState(patch: {
  bootedVersion?: string;
  agentRolloutBy?: string | null;
}): Promise<void> {
  const now = nowIso();
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, ...patch, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { ...patch, updatedAt: now },
    });
}

/** Sign the rollout that follows a panel update with whoever asked for it. */
export async function markAgentRolloutPending(actor: string): Promise<void> {
  await writeRolloutState({ agentRolloutBy: actor });
}

function behindServers(servers: Server[]): Server[] {
  return servers.filter(
    (s) =>
      !s.importOnly &&
      agentUpdateAvailable(reportedAgentVersion(s), AGENT_VERSION),
  );
}

// One that cannot link, or has not yet, is brought back by nothing Deplo does (ADR-0041).
function updatable(s: Server): boolean {
  return updateReaches(agentReach(s));
}

function pausedBy(
  behind: Server[],
  updates: Map<string, AgentUpdateRow>,
): Server | null {
  return (
    behind.find(
      (s) => updatable(s) && updates.get(s.id)?.failure === "no_return",
    ) ?? null
  );
}

/** The fleet as the Updates tab reads it: who is behind, and where each update stands. */
export async function fleetAgentStatus(): Promise<FleetAgentStatus> {
  await requireInstanceAdmin();
  const [servers, updates] = await Promise.all([
    listAllServers(),
    listAgentUpdates(),
  ]);
  const fleet = servers.filter((s) => !s.importOnly);
  const behind = behindServers(fleet);
  const rows = behind.map((s) => {
    const row = updates.get(s.id);
    const reach = agentReach(s);
    return {
      id: s.id,
      name: s.name,
      version: reportedAgentVersion(s),
      usable: reach === "usable",
      reach,
      update: row ? toAgentUpdateDTO(row) : null,
    };
  });
  return {
    expected: AGENT_VERSION,
    minimum: AGENT_MIN_VERSION,
    total: fleet.length,
    behind: rows,
    updating: rows.some((b) => updateReaches(b.reach) && !b.update?.gaveUp),
    pausedBy: pausedBy(behind, updates)?.name ?? null,
  };
}

/** The servers this Deplo refuses, for the admin banner. */
export async function unusableServers(): Promise<
  { id: string; name: string; reach: Exclude<AgentReach, "usable"> }[]
> {
  await requireInstanceAdmin();
  return (await listAllServers()).flatMap((s) => {
    const reach = agentReach(s);
    return !s.importOnly && s.agent?.certFingerprint && reach !== "usable"
      ? [{ id: s.id, name: s.name, reach }]
      : [];
  });
}

/**
 * Remotes first, fewest Apps first, a cluster's leader after the servers in its line, the Deplo host last: a bad
 * release must break a leaf before it breaks the machine that would tell you. See docs/agents/fleet-rollout.md.
 */
export function rolloutOrder(
  servers: Server[],
  appsPerServer: ReadonlyMap<string, number>,
  leaders: ReadonlySet<string> = new Set(),
): Server[] {
  const eligible = servers.filter(
    (s) => Boolean(s.agent?.certFingerprint) && !s.importOnly,
  );
  const remotes = eligible
    .filter((s) => !isDeploHostServer(s))
    .sort(
      (a, b) =>
        Number(leaders.has(a.id)) - Number(leaders.has(b.id)) ||
        (appsPerServer.get(a.id) ?? 0) - (appsPerServer.get(b.id) ?? 0),
    );
  return [...remotes, ...eligible.filter((s) => isDeploHostServer(s))];
}

async function clusterLeaders(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ id: clustersTable.leaderServerId })
    .from(clustersTable);
  return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
}

/** Seam: the leaders a server runs go to the next in line before its agent updates (ADR-0043). */
export const leaderHandOff = { run: handLeadersOff };

async function appsPerServer(): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ serverId: appsTable.serverId, n: count() })
    .from(appsTable)
    .groupBy(appsTable.serverId);
  return new Map(rows.map((r) => [r.serverId ?? "", Number(r.n)]));
}

// deployments.server_id is a nullable mirror of apps.server_id, so a bare read
// makes an in-flight deploy invisible and the agent re-exec drops it.
async function serverBusy(serverId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(appsTable.id, deploymentsTable.appId))
    .where(
      sql`${inArray(deploymentsTable.status, ["queued", "building"])} and coalesce(${deploymentsTable.serverId}, ${appsTable.serverId}) = ${serverId}`,
    )
    .limit(1);
  return rows.length > 0;
}

// Past the minimum-agent gate: the agent being updated is often the one it refuses.
async function helloVersion(serverId: string): Promise<string> {
  const conn = await openAgent(serverId);
  try {
    return (await conn.hello()).agentVersion;
  } finally {
    conn.close();
  }
}

/** The version it came back on; `back` when it answers on the one it had, so the new one went back or never ran. */
async function confirmUpdated(
  serverId: string,
  before: string,
): Promise<{ version: string | null; back: boolean }> {
  for (let i = 0; i < rolloutTiming.confirmTries; i++) {
    await sleep(rolloutTiming.confirmDelayMs);
    try {
      const version = await helloVersion(serverId);
      if (version !== before) {
        await markServerSeen(serverId, version);
        return { version, back: false };
      }
      return { version: null, back: true };
    } catch {}
  }
  return { version: null, back: false };
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("no answer in time")), ms).unref?.(),
    ),
  ]);
}

/**
 * Why the server did not hold on `version` for its first minute, or null: it answers on it, and every cluster it is
 * a member of keeps renewing it (ADR-0043). A leader that restarts or has not heard it yet is asked again.
 */
async function heldOn(server: Server, version: string): Promise<string | null> {
  const memberOf = await getDb()
    .select({ id: clusterMembers.clusterId })
    .from(clusterMembers)
    .where(eq(clusterMembers.serverId, server.id));
  const renewed = new Set<string>();
  let silent = 0;
  const end = Date.now() + rolloutTiming.holdMs;
  while (Date.now() < end) {
    await rolloutTiming.holdWait(rolloutTiming.holdEveryMs);
    try {
      const now = await within(helloVersion(server.id), 5000);
      if (now !== version) return `it answered on v${now}, not v${version}`;
      silent = 0;
    } catch {
      if (++silent >= 2) return "it stopped answering";
    }
    for (const { id } of memberOf) {
      const cluster = await getClusterById(id);
      if (!cluster) continue;
      const view = await within(readLeaderSnapshot(cluster), 5000)
        .then((s) => s?.clusters[id]?.members.find((m) => m.id === server.id))
        .catch(() => undefined);
      if (!view || view.heard === false) continue;
      if (view.state !== "ok")
        return `the leader of cluster ${cluster.name} stopped renewing it`;
      renewed.add(id);
    }
  }
  const unsure = memberOf.find(({ id }) => !renewed.has(id));
  if (unsure) {
    const name = (await getClusterById(unsure.id))?.name ?? unsure.id;
    return `Deplo could not see the leader of cluster ${name} renew it`;
  }
  return null;
}

async function failAttempt(
  server: Server,
  row: AgentUpdateRow,
  failure: AgentUpdateFailure,
  error: string,
  actor: string,
): Promise<void> {
  const {
    firstFailure,
    gaveUp,
    row: next,
  } = await recordAgentUpdateFailure(row, failure, error);
  const stopped = next.failure === "no_return";
  if (stopped && row.failure !== "no_return")
    await recordActivity(
      "server",
      `Could not update the server agent on ${server.name}: ${error}`,
      actor,
    );
  if (firstFailure && !stopped) {
    await recordActivity(
      "server",
      `Could not update the server agent on ${server.name}: ${error} Deplo retries on its own.`,
      actor,
    );
    if (agentReach(server) === "updatable") {
      await recordActivity(
        "server",
        `${server.name} is unusable until its server agent updates to v${AGENT_VERSION}`,
        "Deplo",
      );
      dispatchServerAlert(server.id, {
        key: "agent_incompatible",
        title: `${server.name} is unusable until its server agent updates`,
        body: `Its server agent is too old for this version of Deplo, and the update failed: ${error}`,
        dedupe: { id: `agent:${server.id}`, state: AGENT_VERSION },
        path: `/settings/servers/${server.id}`,
      });
    }
  }
  if (gaveUp && row.nextRetryAt !== null && !stopped)
    await recordActivity(
      "server",
      `Stopped retrying the server agent update on ${server.name} after 24 hours. An instance admin can retry it.`,
      "Deplo",
    );
}

/** One attempt on a server whose slot is already claimed. Never leaves the slot running. */
export async function attemptAgentUpdate(
  server: Server,
  row: AgentUpdateRow,
  actor: string,
): Promise<void> {
  const fail = (failure: AgentUpdateFailure, error: string) =>
    failAttempt(server, row, failure, error, actor);
  try {
    if (await serverBusy(server.id))
      return fail(
        "busy",
        "A deploy is running on it; Deplo updates it once the deploy ends.",
      );
    let before: string;
    try {
      before = await helloVersion(server.id);
    } catch (e) {
      return fail("unreachable", errorText(e));
    }
    if (!agentUpdateAvailable(before, AGENT_VERSION)) {
      await markServerSeen(server.id, before);
      return clearAgentUpdate(server.id);
    }
    await leaderHandOff.run(server.id);
    try {
      await selfUpdateServerAgent(server.id);
    } catch (e) {
      return fail("error", errorText(e));
    }
    const { version, back } = await confirmUpdated(server.id, before);
    if (!version)
      return fail(
        "no_return",
        back
          ? `Its new server agent v${AGENT_VERSION} did not answer within 30 seconds, so it runs v${before} again. Deplo stopped updating the other servers.`
          : "It took the new server agent but did not come back on it. Deplo stopped updating the other servers.",
      );
    if (agentUpdateAvailable(version, AGENT_VERSION))
      return fail(
        "error",
        `It came back on v${version}, not v${AGENT_VERSION}.`,
      );
    const why = await heldOn(server, version);
    if (why)
      return fail(
        "no_return",
        `It came back on v${version}, but ${why} within its first minute. Deplo stopped updating the other servers.`,
      );
    await clearAgentUpdate(server.id);
    await recordActivity(
      "server",
      `Updated the server agent on ${server.name} to v${version}`,
      actor,
    );
    const settle = (await nameServerSettleMs(server.id)) - rolloutTiming.holdMs;
    if (settle > 0) await rolloutTiming.wait(settle);
  } catch (e) {
    await fail("error", errorText(e)).catch(() => {});
  }
}

let pass: Promise<void> | null = null;

/** One pass: every server behind the pin whose retry is due, one at a time, in the safe order. */
export function runAgentRollout(): Promise<void> {
  pass ??= rolloutPass().finally(() => {
    pass = null;
  });
  return pass;
}

async function rolloutPass(): Promise<void> {
  if (await instanceFrozen()) return;
  const behind = behindServers(await listAllServers()).filter(updatable);
  const actor = await rolloutActor();
  if (behind.length === 0) {
    if (actor) await writeRolloutState({ agentRolloutBy: null });
    return;
  }
  // GitHub down: nothing is claimed, so no server's 24 hours run on an outage.
  if (!(await resolveAgentRelease())) return;

  const updates = await listAgentUpdates();
  // An update under way elsewhere (Retry now) is still in its minute: the next server waits for it (ADR-0043).
  const stale = Date.now() - STALE_RUNNING_MS;
  if (
    [...updates.values()].some(
      (r) => r.status === "running" && Date.parse(r.updatedAt) > stale,
    )
  )
    return;
  const suspect = pausedBy(behind, updates);
  if (suspect) {
    const row = await claimAgentUpdate(suspect.id, false);
    if (!row) return;
    await attemptAgentUpdate(suspect, row, actor ?? "Deplo");
    if (await getAgentUpdate(suspect.id)) return;
  }
  for (const server of rolloutOrder(
    behind,
    await appsPerServer(),
    await clusterLeaders(),
  )) {
    const row = await claimAgentUpdate(server.id, false);
    if (!row) continue;
    await attemptAgentUpdate(server, row, actor ?? "Deplo");
    // A release that breaks one agent must not break four.
    if ((await listAgentUpdates()).get(server.id)?.failure === "no_return")
      break;
  }
}

/** At boot: a new pin opens a fresh window, and a version that moved signs the rollout. */
export async function claimBootRollout(): Promise<void> {
  await dropStaleAgentUpdates();
  const rows = await getDb()
    .select({
      bootedVersion: instanceSettings.bootedVersion,
      actor: instanceSettings.agentRolloutBy,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  const state = rows[0] ?? { bootedVersion: null, actor: null };
  await settleUpdateLogAtBoot(state.bootedVersion).catch((e) =>
    console.error("[deplo] the update log could not be settled:", e),
  );
  const updated =
    Boolean(state.bootedVersion) && state.bootedVersion !== DEPLO_VERSION;
  await writeRolloutState({
    bootedVersion: DEPLO_VERSION,
    ...(updated && !state.actor ? { agentRolloutBy: "Deplo" } : {}),
  });
}

export async function startAgentRollout(): Promise<void> {
  const g = globalThis as { __deploAgentRollout?: boolean };
  if (g.__deploAgentRollout) return;
  g.__deploAgentRollout = true;

  await claimBootRollout();

  const tick = () =>
    void runAgentRollout().catch((e) =>
      console.error("[deplo] agent rollout failed:", e),
    );
  setTimeout(tick, FIRST_RUN_MS).unref?.();
  setInterval(tick, TICK_MS).unref?.();
}
