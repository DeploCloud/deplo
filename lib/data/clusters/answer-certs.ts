import "server-only";

import { and, eq, inArray, gte } from "drizzle-orm";
import { getDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { failoverBundlePushes as pushes } from "../../db/schema/control-plane/clusters";
import { decryptSecretOrThrow, encryptSecret } from "../../crypto";
import type { ProxyRestartReport } from "../../infra/agent-client/connection";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { getServerById } from "../servers/roster";
import { answeringApps } from "./answers";
import { type FailoverBundle, bundleMeta, deliver, keyRows } from "./bundles";
import { getClusterById } from "./roster";

// The certificate of a domain that answers on every server travels in its App's failover bundle (ADR-0048).
// https://deplo.build/docs/operations/clusters/addresses

/** One pair as the bundle carries it: the leader passes it on unread, the next server's agent installs it. */
export type BundleCertificate = NonNullable<
  FailoverBundle["certificates"]
>[number];

/** The pairs kept for these hostnames only: a domain whose switch went off takes its key out of the bundle. */
export function keepCertificates(
  certs: BundleCertificate[] | undefined,
  hosts: string[],
): BundleCertificate[] {
  const wanted = new Set(hosts);
  return (certs ?? [])
    .map((c) => ({ ...c, hosts: c.hosts.filter((h) => wanted.has(h)) }))
    .filter((c) => c.hosts.length > 0);
}

/** The hostnames of an App's switched-on domains whose certificate its bundle does not carry yet. */
export function uncarriedHosts(
  certs: BundleCertificate[] | undefined,
  hosts: string[],
  now = Date.now(),
): string[] {
  const carried = new Set(
    (certs ?? [])
      .filter((c) => Date.parse(c.notAfter) > now)
      .flatMap((c) => c.hosts),
  );
  return hosts.filter((h) => !carried.has(h));
}

const same = (a: BundleCertificate[], b: BundleCertificate[]) =>
  JSON.stringify(a.map((c) => [c.sha256, [...c.hosts].sort()])) ===
  JSON.stringify(b.map((c) => [c.sha256, [...c.hosts].sort()]));

async function storedBundleOf(appId: string): Promise<FailoverBundle | null> {
  const [row] = await getDb()
    .select({ bundleEnc: pushes.bundleEnc })
    .from(pushes)
    .where(and(eq(pushes.workloadKind, "app"), eq(pushes.workloadId, appId)))
    .limit(1);
  return row
    ? (JSON.parse(
        decryptSecretOrThrow(row.bundleEnc, "a failover bundle"),
      ) as FailoverBundle)
    : null;
}

/** Names whose certificate every server holds already, the zone's or their own, so no bundle carries it (ADR-0049). */
async function zoneServedHosts(clusterId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ name: domainsTable.name, mode: domainsTable.certChallenge })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(
      and(
        eq(appsTable.clusterId, clusterId),
        inArray(domainsTable.certChallenge, ["zone", "shared"]),
      ),
    );
  return new Set(rows.map((r) => r.name));
}

/** The hostnames of the App's switched-on domains whose failover waits for their certificate. */
export async function answerCertificatesMissing(
  appId: string,
): Promise<string[]> {
  const [app] = await getDb()
    .select({ clusterId: appsTable.clusterId })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (!app?.clusterId) return [];
  const zoneServed = await zoneServedHosts(app.clusterId);
  const hosts = ((await answeringApps(app.clusterId)).get(appId) ?? []).filter(
    (h) => !zoneServed.has(h),
  );
  if (hosts.length === 0) return [];
  return uncarriedHosts((await storedBundleOf(appId))?.certificates, hosts);
}

/**
 * Reads each answering App's certificates from the proxy of the server it runs on and seals any new one into its
 * bundle; a domain whose switch went off loses its pair. Only a changed pair crosses with its key.
 */
export async function syncAnswerCertificates(clusterId: string): Promise<void> {
  if (await instanceFrozen()) return;
  const cluster = await getClusterById(clusterId);
  if (!cluster) return;
  const { readProxyCertificates } =
    await import("../../infra/agent-client/cluster-host");
  const byApp = await answeringApps(clusterId);
  const zoneServed = await zoneServedHosts(clusterId);
  const rows = await getDb()
    .select({ id: appsTable.id, serverId: appsTable.serverId })
    .from(appsTable)
    .where(eq(appsTable.clusterId, clusterId));
  for (const app of rows) {
    const bundle = await storedBundleOf(app.id);
    if (!bundle) continue;
    const hosts = [...new Set(byApp.get(app.id) ?? [])].filter(
      (h) => !zoneServed.has(h),
    );
    const current = bundle.certificates ?? [];
    let next = keepCertificates(current, hosts);
    if (hosts.length > 0 && app.serverId) {
      const known: Record<string, string> = {};
      for (const c of next) for (const h of c.hosts) known[h] = c.sha256;
      try {
        const read = await readProxyCertificates(app.serverId, hosts, known);
        for (const c of read ?? []) {
          if (!c.keyPem || !c.certPem) continue;
          next = next
            .map((n) => ({
              ...n,
              hosts: n.hosts.filter((h) => !c.hosts.includes(h)),
            }))
            .filter((n) => n.hosts.length > 0);
          next.push({
            hosts: c.hosts,
            cert: c.certPem,
            key: c.keyPem,
            sha256: c.sha256,
            notAfter: new Date(c.notAfterUnixMs).toISOString(),
          });
        }
      } catch (e) {
        // The message is the agent's or the link's, never a pair.
        console.warn(
          `[answer-certs] ${clusterId} -> ${app.serverId}: ${messageOf(e).slice(0, 200)}`,
        );
      }
    }
    if (same(current, next)) continue;
    const updated: FailoverBundle = { ...bundle };
    if (next.length > 0) updated.certificates = next;
    else delete updated.certificates;
    const blob = encryptSecret(JSON.stringify(updated));
    // Every stored copy changes, sent or not: a leader that misses it gets it from the sweep.
    await getDb()
      .update(pushes)
      .set({ bundleEnc: blob, pushedAt: null })
      .where(
        and(eq(pushes.workloadKind, "app"), eq(pushes.workloadId, app.id)),
      );
    await deliver(
      cluster,
      updated,
      blob,
      await keyRows(cluster.id),
      await bundleMeta(app.id, updated.stack.imageRef),
    );
  }
}

const SEEN = Symbol.for("deplo.cluster.proxy-restarts.seen");
const seenState = globalThis as unknown as { [SEEN]?: Map<string, number> };
const seen = (): Map<string, number> => (seenState[SEEN] ??= new Map());

/** The newest proxy restart of this server Deplo has recorded, which the next table acknowledges. */
export function proxyRestartsSeen(serverId: string): number {
  return seen().get(serverId) ?? 0;
}

const at = (ms: number) => {
  const d = new Date(ms).toISOString();
  return `${d.slice(0, 10)} at ${d.slice(11, 16)} UTC`;
};

export function proxyRestartMessage(
  server: string,
  r: ProxyRestartReport,
): string {
  const names = r.hosts.join(", ");
  // The zone's own pair handed to another renewer, or a name's own certificate the zone's now serves.
  if (r.dropped && r.zone)
    return r.hosts.some((h) => h.startsWith("*."))
      ? `Deplo restarted the proxy on ${server} ${at(r.atUnixMs)} so another server renews the certificate of ${names}; ${server} keeps serving it. Visitors' open connections to that server reconnected.`
      : `Deplo restarted the proxy on ${server} ${at(r.atUnixMs)} to remove the certificate of ${names}, which its DNS zone's certificate serves now. Visitors' open connections to that server reconnected.`;
  if (r.dropped)
    return `Deplo restarted the proxy on ${server} ${at(r.atUnixMs)} to remove the certificate of ${names}, whose App now runs on another server, so ${server} never renews it. Visitors' open connections to that server reconnected.`;
  const when = r.urgent
    ? `${at(r.atUnixMs)}, at once since no quiet hour was left before the renewal window`
    : `${at(r.atUnixMs)}, its quietest hour before the renewal window`;
  return `Deplo restarted the proxy on ${server} ${when}, so it renews the certificate of ${names} itself. Visitors' open connections to that server reconnected.`;
}

/** Each restart a member made, in the Activity of every team with an App on that server: once, even if handed twice. */
export async function recordProxyRestarts(
  serverId: string,
  restarts: ProxyRestartReport[],
): Promise<void> {
  if (restarts.length === 0) return;
  const server = (await getServerById(serverId))?.name ?? "a server";
  const teams = [
    ...new Set(
      (
        await getDb()
          .select({ teamId: appsTable.teamId })
          .from(appsTable)
          .where(eq(appsTable.serverId, serverId))
      ).map((r) => r.teamId),
    ),
  ];
  let newest = proxyRestartsSeen(serverId);
  for (const r of restarts) {
    const message = proxyRestartMessage(server, r);
    const since = new Date(r.atUnixMs - 60_000).toISOString();
    for (const teamId of teams) {
      const [dup] = await getDb()
        .select({ id: activities.id })
        .from(activities)
        .where(
          and(
            eq(activities.teamId, teamId),
            eq(activities.message, message),
            gte(activities.createdAt, since),
          ),
        )
        .limit(1);
      if (!dup) await recordActivity("server", message, "Deplo", null, teamId);
    }
    newest = Math.max(newest, r.atUnixMs);
  }
  seen().set(serverId, newest);
}

/** Test seam: forget what was recorded, as a Deplo that restarted does. */
export function __forgetProxyRestartsSeen(): void {
  seen().clear();
}
