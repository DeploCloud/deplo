import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { migrationRunTargets as targetsTable } from "../../db/schema/control-plane/migration";
import { nowIso } from "../../ids";
import { requireActiveTeamId } from "../../membership";
import { connectAgent } from "../../infra/agent-client/connect";

import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";

import { sourceAgentReachable } from "../agent-reach";
import { listServersForTeam } from "../servers/roster";
import {
  migrationMachines,
  machinesHolding,
} from "../migration-import/source-machines";

import { UNREACHABLE_SOURCE_HOST } from "./copy-notes";

/**
 * Which of `names` that host actually HAS. `null` when it could not be asked -
 * an agent too old answers that way too, and refusing a copy over a question
 * nobody could answer is the worse mistake.
 *
 * ponytail: `volumeUsage` SIZES each volume (a `du`) to answer a yes/no. A
 * dedicated exists-RPC if this ever runs anywhere hot.
 */
export async function volumesOnHost(
  serverId: string,
  names: string[],
): Promise<Set<string> | null> {
  if (names.length === 0) return new Set();
  try {
    const conn = await connectAgent(serverId);
    try {
      return new Set((await conn.volumeUsage(names)).keys());
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
}

/**
 * Write down that the SOURCE service is now stopped over there. Backing out of a
 * takeover reads exactly these rows to start them again.
 */
export async function recordSourceStopped(
  runId: string,
  serviceId: string,
  kind: string,
): Promise<void> {
  await getDb()
    .update(targetsTable)
    .set({ stoppedKind: kind, stoppedAt: nowIso() })
    .where(
      and(eq(targetsTable.runId, runId), eq(targetsTable.serviceId, serviceId)),
    );
}

/**
 * Every machine behind the panel answers Deplo, or nothing starts. A LIVE hello -
 * the stored status goes green on the agent's own call-home and says nothing
 * about the direction a copy needs.
 */
export async function assertMigrationMachinesReady(
  c: SourceCredential,
  /** The services this run moves: only THEIR machines have to answer. */
  serviceIds: Iterable<string>,
): Promise<void> {
  const teamId = await requireActiveTeamId();
  const machines = await migrationMachines(
    c,
    teamId,
    await machinesHolding(c, serviceIds),
  );
  const notReady: string[] = [];
  for (const m of machines) {
    const name = m.name || m.ipAddress || "the panel's own host";
    if (!m.deploServerId) notReady.push(`${name} has no agent`);
    else if (!(await sourceAgentReachable(m.deploServerId)))
      notReady.push(`${name} does not answer`);
  }
  if (notReady.length > 0)
    throw new Error(
      `Nothing was started: ${notReady.join(", ")}. Deplo reads a service's data off the machine it runs on, so every machine has to answer first - and answering means Deplo dialing its agent on TCP 9443, INBOUND. Installing the agent is the other direction and works behind any firewall, so open that port on any of them that has one. The wizard's Connect step lists them and re-checks each one.`,
    );
}

/**
 * Start again, on the source panel, every service this run stopped to copy it.
 * Best effort and said per service: a source that will not start is a line, not
 * a throw, because whoever is backing out still needs the rest to happen.
 */
export async function restartSourcesStoppedByRun(
  runId: string,
  c: SourceCredential,
): Promise<{ restarted: number; left: string[] }> {
  const stopped = await getDb()
    .select({
      serviceId: targetsTable.serviceId,
      kind: targetsTable.stoppedKind,
      name: targetsTable.projectName,
    })
    .from(targetsTable)
    .where(
      and(eq(targetsTable.runId, runId), isNotNull(targetsTable.stoppedAt)),
    );
  let restarted = 0;
  const left: string[] = [];
  for (const t of stopped) {
    try {
      await sourceClient(c).startService(t.kind ?? "application", t.serviceId);
      await getDb()
        .update(targetsTable)
        .set({ stoppedAt: null, stoppedKind: null })
        .where(
          and(
            eq(targetsTable.runId, runId),
            eq(targetsTable.serviceId, t.serviceId),
          ),
        );
      restarted++;
    } catch (e) {
      left.push(
        `${t.name}: ${e instanceof Error ? e.message : "would not start"}`,
      );
    }
  }
  return { restarted, left };
}

/**
 * The Deplo server that can read a given source host's volumes. Derived from the
 * ADDRESS, and never accepted from the caller.
 */
export async function resolveSourceServer(
  c: SourceCredential,
  teamId: string,
  platformServerId: string,
): Promise<string> {
  const machine = (await migrationMachines(c, teamId)).find(
    (m) => m.sourceId === platformServerId,
  );
  if (!machine)
    throw new Error(
      `${sourceClient(c).displayName} no longer lists the machine this service runs on, so Deplo cannot tell which host holds its data.`,
    );
  if (!machine.deploServerId) throw new Error(UNREACHABLE_SOURCE_HOST);
  const usable = (await listServersForTeam(teamId)).some(
    (s) => s.id === machine.deploServerId && !s.storageOnly,
  );
  if (!usable) throw new Error("That server is not available to this team.");
  return machine.deploServerId;
}
