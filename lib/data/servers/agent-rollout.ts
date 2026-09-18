import "server-only";

import { count, eq, inArray, sql } from "drizzle-orm";

import { resolveExpectedAgentVersion } from "../../agent/release";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import { selfUpdateServerAgent } from "../../infra/agent-client/agent-lifecycle";
import { AgentUpdateUnsupportedError } from "../../infra/agent-client/errors";
import { agentPreflight } from "../../infra/agent-client/preflight";
import { nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import {
  DEPLO_VERSION,
  agentUpdateAvailable,
  reportedAgentVersion,
} from "../../version";
import type { Server } from "../../types/server";
import { recordActivity } from "../activity";
import { SETTINGS_ID } from "../instance-settings/settings-store";
import { markServerSeen } from "./agent-handshake";
import { listAllServers } from "./roster";

const RETRY_MS = 15 * 60_000;
const FIRST_RUN_MS = 20_000;
const CONFIRM_TRIES = 20;
const CONFIRM_DELAY_MS = 1500;

export interface FleetAgentStatus {
  expected: string;
  total: number;
  behind: { id: string; name: string; version: string | null }[];
  updating: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rolloutState(): Promise<{
  bootedVersion: string | null;
  actor: string | null;
}> {
  return getDb()
    .select({
      bootedVersion: instanceSettings.bootedVersion,
      actor: instanceSettings.agentRolloutBy,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .then((rows) => rows[0] ?? { bootedVersion: null, actor: null });
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

/** Arm the rollout that follows a panel update, signed by whoever asked for it. */
export async function markAgentRolloutPending(actor: string): Promise<void> {
  await writeRolloutState({ agentRolloutBy: actor });
}

/** The fleet as the Updates tab reads it: what is behind, and whether Deplo is still working on it. */
export async function fleetAgentStatus(): Promise<FleetAgentStatus> {
  await requireInstanceAdmin();
  const [expected, servers, state] = await Promise.all([
    resolveExpectedAgentVersion(),
    listAllServers(),
    rolloutState(),
  ]);
  const fleet = servers.filter((s) => !s.importOnly);
  return {
    expected,
    total: fleet.length,
    behind: behindServers(fleet, expected).map((s) => ({
      id: s.id,
      name: s.name,
      version: reportedAgentVersion(s),
    })),
    updating: Boolean(state.actor),
  };
}

function behindServers(servers: Server[], expected: string): Server[] {
  return servers.filter((s) =>
    agentUpdateAvailable(reportedAgentVersion(s), expected),
  );
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
async function busyServerIds(): Promise<Set<string>> {
  const rows = await getDb()
    .select({
      serverId: sql<string>`coalesce(${deploymentsTable.serverId}, ${appsTable.serverId})`,
    })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(appsTable.id, deploymentsTable.appId))
    .where(inArray(deploymentsTable.status, ["queued", "building"]));
  return new Set(rows.map((r) => r.serverId).filter(Boolean));
}

async function confirmUpdated(
  serverId: string,
  before: string,
): Promise<string | null> {
  for (let i = 0; i < CONFIRM_TRIES; i++) {
    await sleep(CONFIRM_DELAY_MS);
    try {
      const hello = await agentPreflight(serverId);
      if (hello.agentVersion !== before) {
        await markServerSeen(serverId, hello.agentVersion);
        return hello.agentVersion;
      }
    } catch {}
  }
  return null;
}

let pass: Promise<void> | null = null;

/**
 * One rollout pass: every agent behind the fleet version, one at a time, in the
 * safe order. Skips what it cannot touch now and leaves the marker for the retry.
 */
export function runAgentRollout(): Promise<void> {
  pass ??= rolloutPass().finally(() => {
    pass = null;
  });
  return pass;
}

async function rolloutPass(): Promise<void> {
  const { actor } = await rolloutState();
  if (!actor) return;

  const expected = await resolveExpectedAgentVersion();
  const [servers, load, busy] = await Promise.all([
    listAllServers(),
    appsPerServer(),
    busyServerIds(),
  ]);

  for (const server of rolloutOrder(servers, load)) {
    if (!agentUpdateAvailable(reportedAgentVersion(server), expected)) continue;
    if (busy.has(server.id)) continue;

    let before: string;
    try {
      before = (await agentPreflight(server.id)).agentVersion;
    } catch {
      continue;
    }

    try {
      await selfUpdateServerAgent(server.id);
    } catch (e) {
      // An agent too old to update itself needs its installer re-run: permanent, so it must not block the fleet.
      if (e instanceof AgentUpdateUnsupportedError) continue;
      console.error(`[deplo] agent rollout stopped on ${server.name}:`, e);
      break;
    }

    const version = await confirmUpdated(server.id, before);
    if (!version) {
      console.error(
        `[deplo] agent rollout stopped: ${server.name} never came back on a new version`,
      );
      break;
    }
    await recordActivity(
      "server",
      `Updated the agent on ${server.name} to v${version}`,
      actor,
    );
  }

  const left = behindServers(
    (await listAllServers()).filter((s) => !s.importOnly),
    expected,
  );
  if (left.length === 0) await writeRolloutState({ agentRolloutBy: null });
}

/**
 * At boot: a version that moved means the panel just updated, so the fleet follows it.
 * The marker survives the restart, so the retry outlives the browser tab.
 */
export async function claimBootRollout(): Promise<void> {
  const state = await rolloutState();
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

  // ponytail: retries forever while a host stays behind - a dial every 15 minutes, and the tab says who.
  const tick = () =>
    void runAgentRollout().catch((e) =>
      console.error("[deplo] agent rollout failed:", e),
    );
  setTimeout(tick, FIRST_RUN_MS).unref?.();
  setInterval(tick, RETRY_MS).unref?.();
}
