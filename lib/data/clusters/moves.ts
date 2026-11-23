import "server-only";

import tls from "node:tls";
import { eq } from "drizzle-orm";

import { appDisk } from "../../apps/failover-copy";
import { OUT_OF_REACH } from "../../apps/display-status";
import { leaderHearsEnough } from "../../clusters/failover-reach";
import { getDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import type { App } from "../../types/app";
import { getServerById } from "../servers/roster";
import { serverAddresses } from "../servers/addresses";
import { promotable, replicaRows } from "./replica-state";
import { votingLeaseStates } from "./gone";
import { clusterOutOfReach, sinceClock } from "./reach";
import { getClusterById } from "./roster";

// An App the cluster is moving reads "Moving to eu-2" until its new server answers with a valid certificate,
// and one that cannot move says why (ADR-0049). https://deplo.build/docs/operations/clusters/failover

type Move = { to: string; since: string };
const KEY = Symbol.for("deplo.cluster.moves");
const g = globalThis as unknown as { [KEY]?: Map<string, Move> };
// ponytail: in memory, so a Deplo restarted mid-move reads it as offline until the move lands.
const moves = () => (g[KEY] ??= new Map());

export const NO_COPY = "Offline: no up-to-date copy";
export const NO_MAJORITY = "Offline: waiting for a majority of servers";

/** The leader decided to move the App to this server. */
export function moveStarted(appId: string, toServerId: string): void {
  moves().set(appId, { to: toServerId, since: new Date().toISOString() });
}

export function moveEnded(appId: string): void {
  moves().delete(appId);
}

/** Test seam: forget every move under way. */
export function __forgetMoves(): void {
  moves().clear();
}

type Probe = (address: string, servername: string) => Promise<boolean>;

// The new server answers 443 for the name with a certificate a browser accepts.
const validOn: Probe = (address, servername) =>
  new Promise((resolve) => {
    const s = tls.connect(
      { host: address, port: 443, servername, timeout: 3000 },
      () => {
        const ok = s.authorized;
        s.destroy();
        resolve(ok);
      },
    );
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
let probe = validOn;
export function __setMoveProbeForTest(fn: Probe | null): void {
  probe = fn ?? validOn;
}

/**
 * The move landed on `to`: the App reads "Moving" until every one of its HTTPS domains answers there with a valid
 * certificate, at most three minutes.
 */
export async function moveLanded(
  appId: string,
  to: string,
  opts: { every?: number; within?: number } = {},
): Promise<boolean> {
  const every = opts.every ?? 2000;
  const end = Date.now() + (opts.within ?? 180_000);
  if (!moves().has(appId)) moveStarted(appId, to);
  const names = (
    await getDb()
      .select({ name: domainsTable.name, ssl: domainsTable.ssl })
      .from(domainsTable)
      .where(eq(domainsTable.appId, appId))
  )
    .filter((d) => d.ssl)
    .map((d) => d.name);
  const addrs = await serverAddresses(await getServerById(to), {
    anyFamily: true,
  });
  const all = [...addrs.v6, ...addrs.v4];
  let ok = names.length === 0 || all.length === 0;
  // A newer move, or one that ended, stops this wait.
  while (!ok && Date.now() < end && moves().get(appId)?.to === to) {
    ok = (
      await Promise.all(
        names.map(async (n) => {
          for (const a of all) if (await probe(a, n)) return true;
          return false;
        }),
      )
    ).every(Boolean);
    if (!ok) await new Promise((r) => setTimeout(r, every));
  }
  if (moves().get(appId)?.to === to) moveEnded(appId);
  return ok;
}

/** What the App's status reads beside its runtime: the move under way, or why it cannot move while offline. */
export async function appMoveState(
  app: Pick<
    App,
    "id" | "serverId" | "clusterId" | "volumes" | "mounts" | "compose"
  >,
  unreachable: boolean,
): Promise<{
  move: { to: string; since: string } | null;
  offlineWhy: string | null;
}> {
  const m = moves().get(app.id);
  if (m)
    return {
      move: {
        to: (await getServerById(m.to))?.name ?? "another server",
        since: m.since,
      },
      offlineWhy: null,
    };
  if (!unreachable || !app.clusterId) return { move: null, offlineWhy: null };
  const since = await clusterOutOfReach(app.clusterId);
  if (since)
    return {
      move: null,
      offlineWhy: `${OUT_OF_REACH} since ${sinceClock(since)}`,
    };
  const leases = await votingLeaseStates(app.clusterId);
  const answering = leases.filter((s) => s === "ok").length;
  if (leases.length >= 2 && !leaderHearsEnough(answering, leases.length))
    return { move: null, offlineWhy: NO_MAJORITY };
  const cluster = await getClusterById(app.clusterId);
  if (
    appDisk(app) === "volume" &&
    (!cluster?.replicationEnabled ||
      !promotable(await replicaRows([app.id]), app))
  )
    return { move: null, offlineWhy: NO_COPY };
  return { move: null, offlineWhy: null };
}
