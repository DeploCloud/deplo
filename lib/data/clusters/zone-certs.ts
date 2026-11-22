import "server-only";

import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import type {
  ClusterZoneCertificateState,
  SetClusterZoneRequest,
} from "../../agent/gen/agent";
import { decryptSecretOrThrow, encryptSecret } from "../../crypto";
import { getDb } from "../../db/client";
import {
  clusterDnsZones,
  clusterNameCerts,
  clusterZoneCerts,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { zoneCertNames, type CertChallenge } from "../../deploy/dns-challenge";
import {
  dnsChallengePresent,
  hasDnsChallenge,
  withDnsChallenge,
} from "../../deploy/traefik-cluster";
import {
  certKey,
  chooseRenewer,
  clusterCanCheckOverDns,
  clusterCanShareCerts,
  domainModes,
  renewersLast,
  zoneCertErrorWords,
  zoneCertificatesFor,
  zoneChallenges,
  type NamePlanCert,
  type ZoneCertDomain,
  type ZoneCertMember,
  type ZonePlanZone,
} from "../../deploy/zone-certs";
import { nowIso } from "../../ids";
import {
  DNS_CERTIFICATES_CAPABILITY,
  DNS_CHALLENGE_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
import { connectAgent } from "../../infra/agent-client/connect";
import { serverSupports } from "../../infra/agent-client/preflight";
import type { ZoneCertificateView } from "../../types/cluster-dns";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { loadAppGraph } from "../app-graph-load";
import { instanceFrozen } from "../deplo-move/freeze";
import { requireAppCapability } from "../node-access";
import { recordClusterActivity } from "./cluster-activity";
import { getClusterById, requireClusterAdmin } from "./roster";
import { refreshAcmeCnames } from "./zone-cnames";

// A zone's own certificate and the certificate checks answered from it (ADR-0049 phase 3):
// https://deplo.build/docs/operations/clusters/dns-zone

const g = globalThis as unknown as {
  [k: symbol]: Map<string, unknown> | undefined;
};
const REPORTED = Symbol.for("deplo.cluster.zone-certs.reported");
const PROXIES = Symbol.for("deplo.cluster.dns-challenge.proxies");
/** The zone certificate each member last said it holds, by `serverId zone`: its key goes only where it differs. */
const reported = () => (g[REPORTED] ??= new Map()) as Map<string, string>;
const proxies = () =>
  (g[PROXIES] ??= new Map()) as Map<string, { on: boolean; at: number }>;
// A proxy is read again after this long, in case it was put back by hand.
const PROXY_KNOWN_FOR_MS = 60 * 60_000;

/** Test seam: forget what the members said and what their proxies were seen to have. */
export function __forgetZoneCerts(): void {
  reported().clear();
  proxies().clear();
}

/** Puts the resolver that checks over DNS in a server's proxy, or takes it out; answers whether the proxy changed. */
export async function syncDnsChallengeProxy(
  serverId: string,
  on: boolean,
  opts: { inZonePass?: boolean } = {},
): Promise<boolean> {
  const { fetchHostInfo, withTraefikStackLock, applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  return withTraefikStackLock(serverId, async () => {
    const yaml = (await fetchHostInfo(serverId)).traefikComposeYaml;
    if (!yaml || (on ? hasDnsChallenge(yaml) : !dnsChallengePresent(yaml))) {
      proxies().set(serverId, { on: Boolean(yaml) && on, at: Date.now() });
      return false;
    }
    const res = await applyTraefikConfig(
      serverId,
      { composeYaml: withDnsChallenge(yaml, on) },
      opts,
    );
    if (!res.ok)
      throw new Error(
        res.error || "The proxy on this server refused the change",
      );
    proxies().set(serverId, { on, at: Date.now() });
    return true;
  });
}

/** Whether a server's proxy has that resolver, read again after an hour; one that cannot be read keeps its last answer. */
async function dnsChallengeOn(serverId: string): Promise<boolean> {
  const seen = proxies().get(serverId);
  if (seen && Date.now() - seen.at < PROXY_KNOWN_FOR_MS) return seen.on;
  const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
  try {
    const yaml = (await fetchHostInfo(serverId)).traefikComposeYaml;
    const on = Boolean(yaml) && hasDnsChallenge(yaml);
    proxies().set(serverId, { on, at: Date.now() });
    return on;
  } catch {
    return seen?.on ?? false;
  }
}

/**
 * Every member's proxy gets the resolver while its cluster has a zone and its agent can set checks: one server at a
 * time, as each change restarts its proxy. A member whose agent cannot gets nothing and holds its cluster on HTTP-01.
 */
export async function zoneCertMembers(
  members: {
    serverId: string;
    fingerprint: string | null;
    joinedAt: string;
    emptying: boolean;
  }[],
  reachable: (serverId: string) => boolean,
): Promise<ZoneCertMember[]> {
  const out: ZoneCertMember[] = [];
  for (const m of members) {
    if (!m.fingerprint) continue;
    const caps = reachable(m.serverId)
      ? await capabilitiesOf(m.serverId)
      : null;
    const up = caps !== null;
    let capable = false;
    if (caps?.includes(DNS_CHALLENGE_CAPABILITY)) {
      capable = await dnsChallengeOn(m.serverId);
      if (!capable && !(await instanceFrozen()))
        capable = await syncDnsChallengeProxy(m.serverId, true, {
          inZonePass: true,
        })
          .then(() => dnsChallengeOn(m.serverId))
          .catch((e) => {
            console.warn(
              `[zone-certs] ${m.serverId}: ${messageOf(e).replace(/\s+/g, " ").slice(0, 300)}`,
            );
            return false;
          });
    } else if (!up) capable = proxies().get(m.serverId)?.on ?? true;
    const shares = caps?.includes(DNS_CERTIFICATES_CAPABILITY) ?? false;
    out.push({
      ...m,
      fingerprint: m.fingerprint,
      capable,
      reachable: up,
      shares,
    });
  }
  return out;
}

/** What a server's agent says it can do, or null when it does not answer. */
async function capabilitiesOf(serverId: string): Promise<string[] | null> {
  try {
    const conn = await connectAgent(serverId);
    try {
      return (await conn.hello()).capabilities ?? [];
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
}

/** A server leaving its cluster's zone loses the resolver; it throws when its proxy could not be changed. */
export async function dropDnsChallengeProxy(serverId: string): Promise<void> {
  if (await serverSupports(serverId, DNS_CHALLENGE_CAPABILITY))
    await syncDnsChallengeProxy(serverId, false);
}

export type ZoneCertDomainRow = {
  domainId: string;
  name: string;
  zoneId: string;
  zone: string;
  inside: boolean;
  serverId: string | null;
  appId: string;
  certProvider: string | null;
  acmeCnameSeenAt: string | null;
  certChallenge: string | null;
};

type CertRow = typeof clusterZoneCerts.$inferSelect;
type NameRow = typeof clusterNameCerts.$inferSelect;

/** What one pass of the zone hands each member about certificates, and how it takes their answers back. */
export type ZoneCertPass = {
  challenges: SetClusterZoneRequest["challenges"];
  certificatesFor: (serverId: string) => SetClusterZoneRequest["certificates"];
  order: <M extends { serverId: string }>(members: M[]) => M[];
  /** Takes in one member's report; true when it brought a pair the others do not hold yet. */
  record: (
    serverId: string,
    states: ClusterZoneCertificateState[],
  ) => Promise<boolean>;
  modes: Map<string, CertChallenge>;
};

/** Decides modes, renewers, checks and what each member is told, for one pass of a cluster's zone. */
export async function zoneCertPass(input: {
  clusterId: string;
  clusterName: string;
  wildcard: boolean;
  zones: { id: string; name: string }[];
  domains: ZoneCertDomainRow[];
  members: ZoneCertMember[];
}): Promise<ZoneCertPass> {
  const now = Date.now();
  const rows = await certRows(input.zones.map((z) => z.id));
  const eligible = clusterCanCheckOverDns(input.members);
  const shared = eligible && clusterCanShareCerts(input.members);
  const domains: ZoneCertDomain[] = input.domains.map((d) => ({
    id: d.domainId,
    name: d.name,
    zoneId: d.zoneId,
    zone: d.zone,
    inside: d.inside,
    cnameSeen: d.acmeCnameSeenAt != null,
    serverId: d.serverId,
  }));
  const managed = new Set(
    input.domains
      .filter((d) => (d.certProvider ?? "letsencrypt") === "letsencrypt")
      .map((d) => d.domainId),
  );
  const all = domainModes(domains, {
    wildcard: input.wildcard,
    eligible,
    shared,
  });
  const modes = new Map(
    [...all].map(([id, m]) => [id, managed.has(id) ? m : "http"] as const),
  );
  const zones: ZonePlanZone[] = [];
  for (const z of input.zones) {
    const row = rows.get(z.id) ?? null;
    const pick = chooseRenewer(row, input.members, now);
    if (
      !row ||
      row.renewerServerId !== pick.serverId ||
      row.renewerLostAt !== pick.lostAt
    ) {
      await saveRow(z.id, {
        renewerServerId: pick.serverId,
        renewerLostAt: pick.lostAt,
      });
      if (row?.renewerServerId && pick.serverId !== row.renewerServerId)
        await recordClusterActivity(
          input.clusterId,
          `Another server of ${input.clusterName} now renews the certificate of the DNS zone ${z.name}`,
        );
    }
    zones.push({
      id: z.id,
      name: z.name,
      renewerServerId: pick.serverId,
      sha256: row?.sha256 ?? null,
      notAfter: row?.notAfter ?? null,
      pair: pairOf(row),
    });
  }
  const names = await namePlan(input, domains, modes, now);
  const fpOf = new Map(input.members.map((m) => [m.serverId, m.fingerprint]));
  const sharesOf = new Map(input.members.map((m) => [m.serverId, m.shares]));
  return {
    modes,
    challenges: zoneChallenges({
      zones,
      domains,
      modes,
      names,
      fingerprintOf: (id) => fpOf.get(id) ?? null,
    }),
    certificatesFor: (serverId) =>
      zoneCertificatesFor({
        serverId,
        zones,
        domains,
        modes,
        names,
        shares: sharesOf.get(serverId) ?? false,
        reported: (key) => reported().get(`${serverId} ${key}`),
        now: Date.now(),
      }),
    order: (members) => renewersLast(members, [...zones, ...names]),
    record: async (serverId, states) => {
      let fresh = false;
      for (const st of states) {
        if (st.names?.length) {
          const n = names.find(
            (x) => x.zone === st.zone && x.name === st.names[0],
          );
          if (!n) continue;
          if (st.sha256) reported().set(`${serverId} ${certKey(n)}`, st.sha256);
          // Only the renewer's, as for the zone's own.
          if (n.renewerServerId !== serverId) continue;
          if (st.certPem && st.keyPem && (await takeNamePair(n, st, input)))
            fresh = true;
          await recordNameOrder(n, st, input).catch((e) =>
            console.warn(`[zone-certs] ${n.name}: ${messageOf(e)}`),
          );
          continue;
        }
        const z = zones.find((x) => x.name === st.zone);
        if (!z) continue;
        if (st.sha256) reported().set(`${serverId} ${z.name}`, st.sha256);
        // Only the renewer's: a server back from a power cut may have renewed a pair it no longer renews.
        if (
          z.renewerServerId === serverId &&
          st.certPem &&
          st.keyPem &&
          (await takePair(z, st, input))
        )
          fresh = true;
        if (z.renewerServerId === serverId)
          await recordOrder(z, st, input).catch((e) =>
            console.warn(`[zone-certs] ${z.name}: ${messageOf(e)}`),
          );
      }
      return fresh;
    },
  };
}

/**
 * Each shared name's own certificate: its renewer (first the server its App runs on, which holds the one it ordered
 * over DNS until now), kept while it can renew, and the pair Deplo holds. A name no longer shared loses its row.
 */
async function namePlan(
  input: {
    clusterId: string;
    clusterName: string;
    zones: { id: string; name: string }[];
    members: ZoneCertMember[];
  },
  domains: ZoneCertDomain[],
  modes: Map<string, CertChallenge>,
  now: number,
): Promise<NamePlanCert[]> {
  const zoneIds = input.zones.map((z) => z.id);
  if (zoneIds.length === 0) return [];
  const rows = await getDb()
    .select()
    .from(clusterNameCerts)
    .where(inArray(clusterNameCerts.zoneId, zoneIds));
  const want = domains.filter((d) => modes.get(d.id) === "shared");
  for (const r of rows)
    if (!want.some((d) => d.zoneId === r.zoneId && d.name === r.name))
      await getDb()
        .delete(clusterNameCerts)
        .where(
          and(
            eq(clusterNameCerts.zoneId, r.zoneId),
            eq(clusterNameCerts.name, r.name),
          ),
        );
  const out: NamePlanCert[] = [];
  for (const d of want) {
    if (out.some((n) => n.name === d.name)) continue;
    const row =
      rows.find((r) => r.zoneId === d.zoneId && r.name === d.name) ?? null;
    const pick = chooseRenewer(
      row ?? { renewerServerId: d.serverId, renewerLostAt: null },
      input.members,
      now,
    );
    if (
      !row ||
      row.renewerServerId !== pick.serverId ||
      row.renewerLostAt !== pick.lostAt
    ) {
      await saveNameRow(d.zoneId, d.name, {
        renewerServerId: pick.serverId,
        renewerLostAt: pick.lostAt,
      });
      if (row?.renewerServerId && pick.serverId !== row.renewerServerId)
        await recordClusterActivity(
          input.clusterId,
          `Another server of ${input.clusterName} now renews the certificate of ${d.name}`,
        );
    }
    out.push({
      zoneId: d.zoneId,
      zone: d.zone,
      name: d.name,
      renewerServerId: pick.serverId,
      sha256: row?.sha256 ?? null,
      notAfter: row?.notAfter ?? null,
      pair: pairOf(row),
    });
  }
  return out;
}

async function saveNameRow(
  zoneId: string,
  name: string,
  set: Partial<Omit<NameRow, "zoneId" | "name">>,
): Promise<void> {
  await getDb()
    .insert(clusterNameCerts)
    .values({ zoneId, name, ...set })
    .onConflictDoUpdate({
      target: [clusterNameCerts.zoneId, clusterNameCerts.name],
      set,
    });
}

/** Keeps a name's pair its renewer reported when it is that name's, whole, and lasts longer than Deplo's. */
async function takeNamePair(
  n: NamePlanCert,
  st: ClusterZoneCertificateState,
  ctx: { clusterId: string; clusterName: string },
): Promise<boolean> {
  const read = readZonePair(st.certPem, st.keyPem);
  if (
    !read ||
    read.sha256 !== st.sha256 ||
    read.names.length !== 1 ||
    read.names[0] !== n.name
  )
    return false;
  if (n.notAfter && Date.parse(read.notAfter) <= Date.parse(n.notAfter))
    return false;
  const first = n.sha256 == null;
  const at = nowIso();
  await saveNameRow(n.zoneId, n.name, {
    certPem: st.certPem,
    keyEnc: encryptSecret(st.keyPem),
    sha256: read.sha256,
    notAfter: read.notAfter,
    ...(first ? { issuedAt: at } : {}),
    renewedAt: at,
    error: "",
    errorAt: null,
  });
  n.sha256 = read.sha256;
  n.notAfter = read.notAfter;
  n.pair = { certPem: st.certPem, keyPem: st.keyPem };
  await recordClusterActivity(
    ctx.clusterId,
    first
      ? `Every server of ${ctx.clusterName} now holds the certificate of ${n.name}, valid until ${read.notAfter.slice(0, 10)}`
      : `The certificate of ${n.name} was renewed, valid until ${read.notAfter.slice(0, 10)}`,
  );
  return true;
}

/** The renewer's word on a name's order: a new failure goes to the cluster's Activity once. */
async function recordNameOrder(
  n: NamePlanCert,
  st: ClusterZoneCertificateState,
  ctx: { clusterId: string },
): Promise<void> {
  const [row] = await getDb()
    .select({
      error: clusterNameCerts.error,
      errorAt: clusterNameCerts.errorAt,
      ordering: clusterNameCerts.ordering,
    })
    .from(clusterNameCerts)
    .where(
      and(
        eq(clusterNameCerts.zoneId, n.zoneId),
        eq(clusterNameCerts.name, n.name),
      ),
    );
  const errorAt = st.error ? new Date(st.errorAtUnixMs).toISOString() : null;
  if (
    row &&
    row.error === st.error &&
    row.errorAt === errorAt &&
    row.ordering === st.ordering
  )
    return;
  await saveNameRow(n.zoneId, n.name, {
    error: st.error,
    errorAt,
    ordering: st.ordering,
  });
  if (st.error && errorAt !== row?.errorAt)
    await recordClusterActivity(
      ctx.clusterId,
      `The certificate of ${n.name} could not be issued: ${zoneCertErrorWords(st.error)}`,
    );
}

/** The names whose own certificate every server of the cluster holds now, valid: no bundle carries them. */
export async function sharedCertNames(clusterId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({
      name: clusterNameCerts.name,
      notAfter: clusterNameCerts.notAfter,
    })
    .from(clusterNameCerts)
    .innerJoin(clusterDnsZones, eq(clusterDnsZones.id, clusterNameCerts.zoneId))
    .where(eq(clusterDnsZones.clusterId, clusterId));
  return new Set(
    rows
      .filter((r) => r.notAfter && Date.parse(r.notAfter) > Date.now())
      .map((r) => r.name),
  );
}

async function certRows(zoneIds: string[]): Promise<Map<string, CertRow>> {
  if (zoneIds.length === 0) return new Map();
  const rows = await getDb()
    .select()
    .from(clusterZoneCerts)
    .where(inArray(clusterZoneCerts.zoneId, zoneIds));
  return new Map(rows.map((r) => [r.zoneId, r]));
}

async function saveRow(
  zoneId: string,
  set: Partial<Omit<CertRow, "zoneId">>,
): Promise<void> {
  await getDb()
    .insert(clusterZoneCerts)
    .values({ zoneId, ...set })
    .onConflictDoUpdate({ target: clusterZoneCerts.zoneId, set });
}

function pairOf(row: CertRow | NameRow | null): ZonePlanZone["pair"] {
  if (!row?.certPem || !row.keyEnc) return null;
  try {
    return {
      certPem: row.certPem,
      keyPem: decryptSecretOrThrow(row.keyEnc, "zone certificate key"),
    };
  } catch {
    return null;
  }
}

/** A zone certificate's digest, expiry and names, or null when the pair is not a whole one. */
export function readZonePair(
  certPem: string,
  keyPem: string,
): { sha256: string; notAfter: string; names: string[] } | null {
  try {
    const x = new X509Certificate(certPem);
    if (!x.checkPrivateKey(createPrivateKey(keyPem))) return null;
    const names = (x.subjectAltName ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("DNS:"))
      .map((s) => s.slice(4).toLowerCase());
    return {
      sha256: createHash("sha256").update(x.raw).digest("hex"),
      notAfter: new Date(x.validTo).toISOString(),
      names,
    };
  } catch {
    return null;
  }
}

/** Keeps a pair a member reported when it is this zone's, whole, and lasts longer than the one Deplo holds. */
async function takePair(
  z: ZonePlanZone,
  st: ClusterZoneCertificateState,
  ctx: { clusterId: string; clusterName: string },
): Promise<boolean> {
  const read = readZonePair(st.certPem, st.keyPem);
  const want = zoneCertNames(z.name);
  if (
    !read ||
    read.sha256 !== st.sha256 ||
    read.names.length !== want.length ||
    !want.every((n) => read.names.includes(n))
  )
    return false;
  if (z.notAfter && Date.parse(read.notAfter) <= Date.parse(z.notAfter))
    return false;
  const first = z.sha256 == null;
  const at = nowIso();
  await saveRow(z.id, {
    certPem: st.certPem,
    keyEnc: encryptSecret(st.keyPem),
    sha256: read.sha256,
    notAfter: read.notAfter,
    ...(first ? { issuedAt: at } : {}),
    renewedAt: at,
    error: "",
    errorAt: null,
  });
  z.sha256 = read.sha256;
  z.notAfter = read.notAfter;
  z.pair = { certPem: st.certPem, keyPem: st.keyPem };
  await recordClusterActivity(
    ctx.clusterId,
    first
      ? `The DNS zone ${z.name} of ${ctx.clusterName} got its certificate, valid until ${read.notAfter.slice(0, 10)}`
      : `The certificate of the DNS zone ${z.name} was renewed, valid until ${read.notAfter.slice(0, 10)}`,
  );
  return true;
}

/** The renewer's word on its order: a new failure goes to the cluster's Activity once, in plain words. */
async function recordOrder(
  z: ZonePlanZone,
  st: ClusterZoneCertificateState,
  ctx: { clusterId: string; clusterName: string },
): Promise<void> {
  const [row] = await getDb()
    .select({
      error: clusterZoneCerts.error,
      errorAt: clusterZoneCerts.errorAt,
      ordering: clusterZoneCerts.ordering,
    })
    .from(clusterZoneCerts)
    .where(eq(clusterZoneCerts.zoneId, z.id));
  const errorAt = st.error ? new Date(st.errorAtUnixMs).toISOString() : null;
  if (
    row &&
    row.error === st.error &&
    row.errorAt === errorAt &&
    row.ordering === st.ordering
  )
    return;
  await saveRow(z.id, { error: st.error, errorAt, ordering: st.ordering });
  if (st.error && errorAt !== row?.errorAt)
    await recordClusterActivity(
      ctx.clusterId,
      `The certificate of the DNS zone ${z.name} could not be issued: ${zoneCertErrorWords(st.error)}`,
    );
}

/**
 * Routes each domain the way its certificate is now checked. A domain is marked first and its App routed again; a
 * reroute that fails puts the mark back, so the next pass tries again.
 */
export async function applyCertModes(
  domains: ZoneCertDomainRow[],
  modes: Map<string, CertChallenge>,
  reroute: (appId: string) => Promise<unknown> = async (id) =>
    (await import("../../deploy/build/reroute")).rerouteApp(id),
): Promise<void> {
  const byApp = new Map<string, { id: string; was: string | null }[]>();
  for (const d of domains) {
    const mode = modes.get(d.domainId) ?? "http";
    const next = mode === "http" ? null : mode;
    if ((d.certChallenge ?? null) === next) continue;
    const list = byApp.get(d.appId) ?? [];
    list.push({ id: d.domainId, was: d.certChallenge });
    byApp.set(d.appId, list);
    await getDb()
      .update(domainsTable)
      .set({ certChallenge: next })
      .where(eq(domainsTable.id, d.domainId));
  }
  for (const [appId, list] of byApp) {
    if (await instanceFrozen()) return;
    try {
      await reroute(appId);
    } catch (e) {
      console.warn(`[zone-certs] reroute ${appId}: ${messageOf(e)}`);
      for (const d of list)
        await getDb()
          .update(domainsTable)
          .set({ certChallenge: d.was })
          .where(eq(domainsTable.id, d.id));
    }
  }
}

/** The Advanced switch: off, every name in the zone gets a certificate of its own over DNS instead. */
export async function setClusterDnsWildcard(
  clusterId: string,
  on: boolean,
): Promise<void> {
  if (await instanceFrozen())
    throw new Error(
      "Deplo is moving to another machine; try again once it is done.",
    );
  const { teamId, user } = await requireClusterAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  if (cluster.dnsWildcard === on) return;
  await getDb()
    .update(clustersTable)
    .set({ dnsWildcard: on })
    .where(eq(clustersTable.id, clusterId));
  await recordActivity(
    "server",
    on
      ? `Each DNS zone of cluster ${cluster.name} now has one certificate for every name in it`
      : `Each name in cluster ${cluster.name}'s DNS zones now gets a certificate of its own`,
    user.name,
    null,
    teamId,
  );
  const { syncClusterZoneSoon } = await import("./dns-zone");
  syncClusterZoneSoon(clusterId);
}

/** How each zone's own certificate stands, for the cluster's settings: never its key. */
export async function zoneCertificateViews(
  zones: { id: string; name: string }[],
  serverName: (serverId: string) => string,
): Promise<Map<string, ZoneCertificateView>> {
  const rows = await certRows(zones.map((z) => z.id));
  const served = zones.length
    ? await getDb()
        .select({ name: domainsTable.name, zoneId: domainsTable.dnsZoneId })
        .from(domainsTable)
        .where(eq(domainsTable.certChallenge, "zone"))
    : [];
  const out = new Map<string, ZoneCertificateView>();
  for (const z of zones) {
    const row = rows.get(z.id);
    out.set(z.id, {
      names: zoneCertNames(z.name),
      serves: [
        ...new Set(
          served
            .filter((d) => d.name === z.name || d.name.endsWith(`.${z.name}`))
            .map((d) => d.name),
        ),
      ].sort(),
      validUntil: row?.notAfter ?? null,
      valid: !!row?.notAfter && Date.parse(row.notAfter) > Date.now(),
      issuedAt: row?.issuedAt ?? null,
      renewedAt: row?.renewedAt ?? null,
      renewer: row?.renewerServerId
        ? {
            serverId: row.renewerServerId,
            serverName: serverName(row.renewerServerId),
          }
        : null,
      ordering: row?.ordering ?? false,
      error: row?.error ? zoneCertErrorWords(row.error) : "",
      errorDetail: row?.error ?? "",
      errorAt: row?.errorAt ?? null,
    });
  }
  return out;
}

/** Looks a domain's `_acme-challenge` CNAME up now; once seen, its certificate is checked over DNS from the zone. */
export async function checkDomainAcmeCname(domainId: string): Promise<boolean> {
  const [d] = await getDb()
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, domainId))
    .limit(1);
  if (!d) throw new Error("Not found");
  await requireAppCapability(d.appId, "manage_domains");
  const app = await loadAppGraph(d.appId);
  if (!app?.clusterId) throw new Error("This App is not on a cluster.");
  const { syncClusterZoneSoon } = await import("./dns-zone");
  const { domainNativeZone } = await import("./zone-domains");
  const native = await domainNativeZone(app.clusterId, {
    name: d.name,
    zoneId: d.dnsZoneId,
  });
  if (!native || native.target === native.zone || native.target === d.name)
    throw new Error(`${d.name} is not pointed into the cluster's zone.`);
  const row = {
    domainId: d.id,
    name: d.name,
    target: native.target,
    inside: false,
    acmeCnameSeenAt: d.acmeCnameSeenAt,
  };
  await refreshAcmeCnames([row]);
  if ((row.acmeCnameSeenAt != null) !== (d.acmeCnameSeenAt != null))
    syncClusterZoneSoon(app.clusterId);
  return row.acmeCnameSeenAt != null;
}
