import "server-only";

import { count, eq, inArray, sql } from "drizzle-orm";

import { resolveAgentRelease } from "../../agent/release";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
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
  type AgentReach,
} from "../../version";
import type { Server } from "../../types/server";
import { recordActivity } from "../activity";
import { SETTINGS_ID } from "../instance-settings/settings-store";
import { markServerSeen } from "./agent-handshake";
import {
  type AgentUpdateDTO,
  type AgentUpdateFailure,
  type AgentUpdateRow,
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

const TICK_MS = 60_000;
const FIRST_RUN_MS = 20_000;
export const rolloutTiming = { confirmTries: 20, confirmDelayMs: 1500 };

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

function pausedBy(
  behind: Server[],
  updates: Map<string, AgentUpdateRow>,
): Server | null {
  return behind.find((s) => updates.get(s.id)?.failure === "no_return") ?? null;
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
    updating: rows.some((b) => !b.update?.gaveUp),
    pausedBy: pausedBy(behind, updates)?.name ?? null,
  };
}

/** The servers this Deplo refuses, for the admin banner. */
export async function unusableServers(): Promise<
  { name: string; reach: Exclude<AgentReach, "usable"> }[]
> {
  await requireInstanceAdmin();
  return (await listAllServers()).flatMap((s) => {
    const reach = agentReach(s);
    return !s.importOnly && s.agent?.certFingerprint && reach !== "usable"
      ? [{ name: s.name, reach }]
      : [];
  });
}

/**
 * Remotes first, fewest Apps first, the Deplo host last: a bad release must break
 * a leaf before it breaks the machine that would tell you. See docs/agents/fleet-rollout.md.
 */
export function rolloutOrder(
  servers: Server[],
  appsPerServer: ReadonlyMap<string, number>,
  self: ReadonlySet<string> = deploHostSelfAddresses(),
): Server[] {
  const eligible = servers.filter(
    (s) => Boolean(s.agent?.certFingerprint) && !s.importOnly,
  );
  const remotes = eligible
    .filter((s) => !isDeploHostServer(s, self))
    .sort(
      (a, b) => (appsPerServer.get(a.id) ?? 0) - (appsPerServer.get(b.id) ?? 0),
    );
  return [...remotes, ...eligible.filter((s) => isDeploHostServer(s, self))];
}

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

async function confirmUpdated(
  serverId: string,
  before: string,
): Promise<string | null> {
  for (let i = 0; i < rolloutTiming.confirmTries; i++) {
    await sleep(rolloutTiming.confirmDelayMs);
    try {
      const version = await helloVersion(serverId);
      if (version !== before) {
        await markServerSeen(serverId, version);
        return version;
      }
    } catch {}
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
  const { firstFailure, gaveUp } = await recordAgentUpdateFailure(
    row,
    failure,
    error,
  );
  const reach = agentReach(server);
  if (firstFailure && reach !== "reinstall")
    await recordActivity(
      "server",
      `Could not update the agent on ${server.name}: ${error} Deplo retries on its own.`,
      actor,
    );
  if (firstFailure && reach !== "usable")
    await reportUnusable(server, reach, error);
  if (gaveUp && row.nextRetryAt !== null && reach !== "reinstall")
    await recordActivity(
      "server",
      `Stopped retrying the agent update on ${server.name} after 24 hours. An instance admin can retry it.`,
      "Deplo",
    );
}

// One activity line and one alert; too old to link, it never reaches this Deplo (ADR-0040).
async function reportUnusable(
  server: Server,
  reach: Exclude<AgentReach, "usable">,
  error: string,
): Promise<void> {
  const [state, detail, body] =
    reach === "reinstall"
      ? [
          "is unusable until its server agent is reinstalled",
          ": it is too old to connect to this Deplo",
          "Its server agent is too old to connect to this version of Deplo. Reissue its install command and run it on the server.",
        ]
      : [
          "is unusable until its server agent updates",
          ` to v${AGENT_VERSION}`,
          `Its server agent is too old for this version of Deplo, and the update failed: ${error}`,
        ];
  await recordActivity("server", `${server.name} ${state}${detail}`, "Deplo");
  dispatchServerAlert(server.id, {
    key: "agent_incompatible",
    title: `${server.name} ${state}`,
    body,
    dedupe: { id: `agent:${server.id}`, state: AGENT_VERSION },
    path: `/settings/servers/${server.id}`,
  });
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
    try {
      await selfUpdateServerAgent(server.id);
    } catch (e) {
      return fail("error", errorText(e));
    }
    const version = await confirmUpdated(server.id, before);
    if (!version)
      return fail(
        "no_return",
        "It took the new agent but did not come back on it. The other servers wait until it does.",
      );
    if (agentUpdateAvailable(version, AGENT_VERSION))
      return fail(
        "error",
        `It came back on v${version}, not v${AGENT_VERSION}.`,
      );
    await clearAgentUpdate(server.id);
    await recordActivity(
      "server",
      `Updated the agent on ${server.name} to v${version}`,
      actor,
    );
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
  const behind = behindServers(await listAllServers());
  const actor = await rolloutActor();
  if (behind.length === 0) {
    if (actor) await writeRolloutState({ agentRolloutBy: null });
    return;
  }
  // GitHub down: nothing is claimed, so no server's 24 hours run on an outage.
  if (!(await resolveAgentRelease())) return;

  const suspect = pausedBy(behind, await listAgentUpdates());
  if (suspect) {
    const row = await claimAgentUpdate(suspect.id, false);
    if (!row) return;
    await attemptAgentUpdate(suspect, row, actor ?? "Deplo");
    if (await getAgentUpdate(suspect.id)) return;
  }
  for (const server of rolloutOrder(behind, await appsPerServer())) {
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
