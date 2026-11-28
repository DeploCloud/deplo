import "server-only";

import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { connect } from "node:tls";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  clusterDnsZones,
  clusterMembers,
  clusterNameServers,
} from "../../db/schema/control-plane/clusters";
import {
  serverAddresses as addressesTable,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { isLoopbackIp } from "../../deploy/domains";
import { nowIso } from "../../ids";
import { ADDRESS_PROVE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import type { AddressFamily, Server } from "../../types/server";
import { messageOf } from "../../utils";
import { instanceFrozen } from "../deplo-move/freeze";

// Deplo finds a server's public addresses and publishes one only once it proves it reaches that server (ADR-0050):
// https://deplo.build/docs/operations/servers/addresses

/** A proven address that stops reaching its server leaves after failing this long without a break. */
export const ADDRESS_LEAVES_AFTER_MS = 30 * 60_000;
export const ADDRESS_CHECK_EVERY_MS = 2 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const CHECK_NAME = "deplo-address-check.invalid";

export type AddressOrigin = "machine" | "traffic" | "typed";
export type AddressRow = typeof addressesTable.$inferSelect;

/** What the server page shows of one address: in use, leaving (with when), checking, not checked, or not used. */
export type AddressView = {
  address: string;
  family: AddressFamily;
  /** On a private network or VPN: only an admin picks it, Automatic never does. */
  isPrivate: boolean;
  state: "inUse" | "leaving" | "checking" | "notChecked" | "notUsed";
  /** One short line: why it is not used, or why it is leaving. */
  problem: string;
  /** When a leaving address leaves, if it keeps failing. */
  leavesAt: string | null;
  checkedAt: string | null;
};

const familyOf = (a: string): AddressFamily =>
  isIP(a) === 6 ? "ipv6" : "ipv4";
const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

/** RFC 1918, the 100.64.0.0/10 range VPNs use, and IPv6 unique local (fc00::/7). */
export function isPrivateAddress(a: string): boolean {
  if (isIP(a) === 4)
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      a,
    );
  return isIP(a) === 6 && /^f[cd]/i.test(a);
}

/** Whether Deplo names an address: proven and not failing for long, or, before Deplo could check it, on the machine. */
export function addressPublished(row: AddressRow, now = Date.now()): boolean {
  if (row.provenAt)
    return (
      !row.failingSince || now - ms(row.failingSince) < ADDRESS_LEAVES_AFTER_MS
    );
  // Never checked: typed (the upgrade keeps a working server) or on the machine (Deplo cannot reach its family).
  return !row.checkedAt && row.origin !== "traffic";
}

export function addressView(row: AddressRow, now = Date.now()): AddressView {
  const base = {
    address: row.address,
    family: familyOf(row.address),
    isPrivate: isPrivateAddress(row.address),
    problem: row.problem,
    leavesAt: null as string | null,
    checkedAt: row.checkedAt,
  };
  if (row.provenAt && row.failingSince && addressPublished(row, now))
    return {
      ...base,
      state: "leaving",
      leavesAt: new Date(
        ms(row.failingSince) + ADDRESS_LEAVES_AFTER_MS,
      ).toISOString(),
    };
  if (addressPublished(row, now))
    return {
      ...base,
      state: row.provenAt ? "inUse" : row.problem ? "notChecked" : "checking",
    };
  if (!row.checkedAt)
    return { ...base, state: row.problem ? "notChecked" : "checking" };
  return { ...base, state: "notUsed" };
}

const ORIGIN_RANK: Record<string, number> = {
  machine: 3,
  traffic: 2,
  typed: 1,
};

/** The addresses Deplo names for a server, IPv4 and IPv6, or null while none was checked yet (the old rule holds).
 *  Private ones only with includePrivate: Automatic never names one. */
export async function publishedServerAddresses(
  serverId: string,
  now = Date.now(),
  opts: { includePrivate?: boolean } = {},
): Promise<{ v4: string[]; v6: string[] } | null> {
  let rows: AddressRow[];
  try {
    rows = await getDb()
      .select()
      .from(addressesTable)
      .where(eq(addressesTable.serverId, serverId));
  } catch {
    // Unreadable (a unit with no database): the old rule holds, as before the first check.
    return null;
  }
  if (!opts.includePrivate)
    rows = rows.filter((r) => !isPrivateAddress(r.address));
  if (!rows.some((r) => r.checkedAt)) return null;
  const used = rows
    .filter((r) => addressPublished(r, now))
    .sort(
      (a, b) =>
        Number(!!b.provenAt) - Number(!!a.provenAt) ||
        (ORIGIN_RANK[b.origin] ?? 0) - (ORIGIN_RANK[a.origin] ?? 0) ||
        a.address.localeCompare(b.address),
    )
    .map((r) => r.address);
  return {
    v4: used.filter((a) => isIP(a) === 4),
    v6: used.filter((a) => isIP(a) === 6),
  };
}

/** The server page's list: an instance admin's, as every server record is. */
export async function listServerAddresses(
  serverId: string,
): Promise<AddressView[]> {
  const { requireInstanceAdmin } = await import("../../membership");
  await requireInstanceAdmin();
  return serverAddressViews(serverId);
}

/** Every address Deplo found for a server, as its page shows them. */
export async function serverAddressViews(
  serverId: string,
): Promise<AddressView[]> {
  const rows = await getDb()
    .select()
    .from(addressesTable)
    .where(eq(addressesTable.serverId, serverId));
  const now = Date.now();
  return rows
    .map((r) => addressView(r, now))
    .sort(
      (a, b) =>
        a.family.localeCompare(b.family) || a.address.localeCompare(b.address),
    );
}

/** The TXT a server's name server answers for _deplo-server.<zone>: its certificate, hashed, as its agent does. */
export function serverIdent(fingerprint: string): string {
  return createHash("sha256")
    .update(`deplo-server:${fingerprint}`)
    .digest("hex")
    .slice(0, 32);
}

export type ProbeResult =
  | { ok: true; value: string }
  | { ok: false; why: "closed" | "silent" | "unreachable" };

const failure = (e: unknown): ProbeResult => {
  const code = (e as { code?: string })?.code ?? "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET")
    return { ok: false, why: "closed" };
  // Deplo has no route to that family: nothing is learned about the address.
  if (
    code === "ENETUNREACH" ||
    code === "EADDRNOTAVAIL" ||
    code === "EAFNOSUPPORT"
  )
    return { ok: false, why: "unreachable" };
  return { ok: false, why: "silent" };
};

/** The certificate digest that answers on an address's 443 for a name no route has. */
function probeTls(address: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({
      host: address,
      port: 443,
      servername: CHECK_NAME,
      // Read, never trusted: compared with what the server's own agent sees.
      rejectUnauthorized: false,
      timeout: PROBE_TIMEOUT_MS,
    });
    const done = (r: ProbeResult) => {
      socket.destroy();
      resolve(r);
    };
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate()?.raw;
      done(
        raw
          ? { ok: true, value: createHash("sha256").update(raw).digest("hex") }
          : { ok: false, why: "silent" },
      );
    });
    socket.once("timeout", () => done({ ok: false, why: "silent" }));
    socket.once("error", (e) => done(failure(e)));
  });
}

/** The ident a name server on an address's 53 answers for a zone. */
async function probeDns(address: string, zone: string): Promise<ProbeResult> {
  const r = new Resolver({ timeout: PROBE_TIMEOUT_MS, tries: 2 });
  r.setServers([isIP(address) === 6 ? `[${address}]` : address]);
  try {
    const txt = await r.resolveTxt(`_deplo-server.${zone}`);
    return { ok: true, value: txt.flat().join("") };
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    if (code === "ECONNREFUSED") return { ok: false, why: "closed" };
    if (
      code === "ENOTFOUND" ||
      code === "ENODATA" ||
      code === "EREFUSED" ||
      code === "ESERVFAIL"
    )
      return { ok: true, value: "" };
    return failure(e);
  }
}

let probes = { tls: probeTls, dns: probeDns };
export function __setAddressProbesForTest(
  p: Partial<typeof probes> | null,
): void {
  probes = p ? { ...probes, ...p } : { tls: probeTls, dns: probeDns };
}

type Proof = { cert: string; ident: string; zone: string | null };
type Outcome =
  { reaches: true } | { reaches: false; problem: string; unchecked?: boolean };

/** Whether an address reaches this server: its 443, and its 53 for a name server, answer as only this one does. */
export async function checkAddress(
  address: string,
  name: string,
  proof: Proof,
  others: Map<string, string>,
): Promise<Outcome> {
  const lead = `${address} does not reach ${name}`;
  const tls = await probes.tls(address);
  if (!tls.ok) {
    if (tls.why === "unreachable")
      return {
        reaches: false,
        unchecked: true,
        problem: `Not checked: Deplo has no ${familyOf(address) === "ipv6" ? "IPv6" : "IPv4"} route to check it from`,
      };
    return {
      reaches: false,
      problem:
        tls.why === "closed"
          ? `${lead}: port 443 is closed`
          : `${lead}: nothing answers on port 443`,
    };
  }
  if (tls.value !== proof.cert) {
    const to = others.get(tls.value);
    return {
      reaches: false,
      problem: to
        ? `${lead}: port 443 goes to ${to}`
        : `${lead}: the router sends port 443 elsewhere`,
    };
  }
  if (proof.zone && proof.ident) {
    const dns = await probes.dns(address, proof.zone);
    if (!dns.ok)
      return {
        reaches: false,
        problem:
          dns.why === "closed"
            ? `${lead}: port 53 is closed`
            : `${lead}: nothing answers on port 53`,
      };
    if (dns.value !== proof.ident)
      return {
        reaches: false,
        problem: `${lead}: port 53 goes to another machine`,
      };
  }
  return { reaches: true };
}

// Public and private (an admin may pick one); never loopback, link-local, mapped or deplo-clat's 192.0.0.0/24.
function candidateIp(raw: string | null | undefined): string | null {
  const a = (raw ?? "").trim().replace(/^\[|\]$/g, "");
  const family = isIP(a);
  if (!family || isLoopbackIp(a)) return null;
  if (family === 4 && /^(127\.|169\.254\.|192\.0\.0\.)/.test(a)) return null;
  if (family === 6 && /^(::1$|fe[89ab]|::ffff:)/i.test(a)) return null;
  return a;
}

/** The zone a name server of this server's cluster answers, so 53 can be checked under it; null for any other. */
export async function zoneServed(serverId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ zone: clusterDnsZones.name })
    .from(clusterNameServers)
    .innerJoin(
      clusterDnsZones,
      eq(clusterDnsZones.clusterId, clusterNameServers.clusterId),
    )
    .where(eq(clusterNameServers.serverId, serverId))
    .limit(1);
  return row?.zone ?? null;
}

/** The echo the agent asks over each family for the address its traffic leaves from. */
function echoUrl(): string {
  const base = (process.env.DEPLO_PUBLIC_URL ?? "").replace(/\/+$/, "");
  return /^https?:\/\//.test(base) ? `${base}/api/address` : "";
}

type Gathered = {
  server: Server;
  proof: Proof;
  found: Map<string, AddressOrigin>;
};

async function gather(server: Server): Promise<Gathered | null> {
  const { connectAgent } = await import("../../infra/agent-client/connect");
  try {
    const conn = await connectAgent(server.id);
    try {
      const hello = await conn.hello();
      if (!hello.capabilities?.includes(ADDRESS_PROVE_CAPABILITY)) return null;
      const r = await conn.proveAddresses(echoUrl());
      const found = new Map<string, AddressOrigin>();
      for (const a of [...r.trafficAddresses, server.connectedFrom]) {
        const p = candidateIp(a);
        if (p) found.set(p, "traffic");
      }
      for (const a of hello.publicAddresses ?? []) {
        const p = candidateIp(a);
        if (p) found.set(p, "machine");
      }
      return {
        server,
        found,
        proof: {
          cert: r.proxyCertificateSha256,
          ident: r.dnsIdent,
          zone: await zoneServed(server.id),
        },
      };
    } finally {
      conn.close();
    }
  } catch (e) {
    console.warn(`[addresses] ${server.id}: ${messageOf(e).slice(0, 200)}`);
    return null;
  }
}

/** One server's addresses brought up to date: found, checked, and kept or let go; says whether what it names moved. */
async function settle(
  g: Gathered,
  others: Map<string, string>,
): Promise<boolean> {
  const db = getDb();
  const id = g.server.id;
  const now = nowIso();
  const before = await publishedServerAddresses(id);
  let rows = await db
    .select()
    .from(addressesTable)
    .where(eq(addressesTable.serverId, id));
  // The upgrade: the addresses it was added at stay in use until their first check.
  if (rows.length === 0)
    for (const a of new Set([g.server.ip, g.server.host].map(candidateIp)))
      if (a)
        await db
          .insert(addressesTable)
          .values({ serverId: id, address: a, origin: "typed", seenAt: now })
          .onConflictDoNothing();
  for (const [address, origin] of g.found) {
    const had = rows.find((r) => r.address === address);
    const keep =
      had && (ORIGIN_RANK[had.origin] ?? 0) > ORIGIN_RANK[origin]
        ? had.origin
        : origin;
    await db
      .insert(addressesTable)
      .values({ serverId: id, address, origin: keep, seenAt: now })
      .onConflictDoUpdate({
        target: [addressesTable.serverId, addressesTable.address],
        set: { origin: keep, seenAt: now },
      });
  }
  rows = await db
    .select()
    .from(addressesTable)
    .where(eq(addressesTable.serverId, id));
  if (!g.proof.cert) return false;
  for (const row of rows) {
    const out = await checkAddress(row.address, g.server.name, g.proof, others);
    const where = and(
      eq(addressesTable.serverId, id),
      eq(addressesTable.address, row.address),
    );
    if (out.reaches) {
      await db
        .update(addressesTable)
        .set({ checkedAt: now, provenAt: now, failingSince: null, problem: "" })
        .where(where);
      continue;
    }
    if (out.unchecked) {
      await db
        .update(addressesTable)
        .set({ problem: out.problem })
        .where(where);
      continue;
    }
    // Gone from the machine and failing: the machine itself says so, so it leaves at once. A typed one stays,
    // not used, to say why.
    if (!g.found.has(row.address) && row.origin !== "typed") {
      await db.delete(addressesTable).where(where);
      continue;
    }
    await db
      .update(addressesTable)
      .set({
        checkedAt: now,
        failingSince: row.failingSince ?? now,
        problem: out.problem,
      })
      .where(where);
  }
  const after = await publishedServerAddresses(id);
  return JSON.stringify(before) !== JSON.stringify(after);
}

let running = false;

/** Every online server's addresses, found and proven again; what moved is followed by its names and zone. */
export async function checkServerAddresses(): Promise<void> {
  if (running || (await instanceFrozen())) return;
  running = true;
  try {
    const { listAllServers } = await import("./roster");
    const servers = (await listAllServers()).filter(
      (s) => s.status === "online" && s.agent?.certFingerprint && !s.importOnly,
    );
    const gathered = (await Promise.all(servers.map(gather))).filter(
      (g): g is Gathered => g !== null,
    );
    const certs = new Map(
      gathered
        .filter((g) => g.proof.cert)
        .map((g) => [g.proof.cert, g.server.name]),
    );
    const { serverWildcardIp } = await import("./addresses");
    for (const g of gathered) {
      const others = new Map([...certs].filter(([, n]) => n !== g.server.name));
      const from = await serverWildcardIp(g.server);
      if (await settle(g, others)) await followAddresses(g.server.id, from);
    }
  } finally {
    running = false;
  }
}

/** What Deplo names for a server moved: its generated names, its row's address, and its cluster's zone follow. */
export async function followAddresses(
  serverId: string,
  from: string | null,
): Promise<void> {
  const [{ getServerById }, { serverWildcardIp }, { rehostServerDomains }] =
    await Promise.all([
      import("./roster"),
      import("./addresses"),
      import("./address-family"),
    ]);
  const server = await getServerById(serverId);
  if (!server) return;
  const to = await serverWildcardIp(server);
  // Generated names embed the address, so they move with it.
  if (from && to && from !== to) await rehostServerDomains(serverId, from, to);
  // The row keeps the automatic one: relays dial it, and an admin's choice may be private.
  const own = server.preferredAddress
    ? await serverWildcardIp({ ...server, preferredAddress: null })
    : to;
  if (own && own !== server.ip && !server.deploHost) {
    await getDb()
      .update(serversTable)
      .set({ ip: own, host: own })
      .where(eq(serversTable.id, serverId));
    // A relay beside a leader here is dialed at this address; its clusters hear the new one now.
    const { followServerAddress } = await import("../clusters/relay");
    await followServerAddress(serverId);
  }
  const clusters = await getDb()
    .select({ id: clusterMembers.clusterId })
    .from(clusterMembers)
    .where(inArray(clusterMembers.serverId, [serverId]));
  const [{ syncClusterAnswerDnsSoon }, { syncClusterZoneSoon }] =
    await Promise.all([
      import("../clusters/answer-dns"),
      import("../clusters/dns-zone"),
    ]);
  for (const c of clusters) {
    syncClusterAnswerDnsSoon(c.id);
    syncClusterZoneSoon(c.id);
  }
}
