import "server-only";

import { randomInt } from "node:crypto";
import dgram from "node:dgram";
import { promises as dnsp } from "node:dns";
import net from "node:net";

import type { DelegationCheck } from "../../types/cluster-dns";
import {
  decodeAnswer,
  encodeQuery,
  QTYPE,
  type QType,
  type WireAnswer,
} from "../../dns/wire";

// Whether a zone is delegated to its cluster (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

const ASK_TIMEOUT_MS = 3000;

export type ExpectedNameServer = { name: string; v4: string[]; v6: string[] };

export type DelegationDeps = {
  /** The zone above this one that has name servers, and their addresses. */
  parentOf(zone: string): Promise<{ zone: string; servers: string[] } | null>;
  ask(server: string, name: string, type: QType): Promise<WireAnswer>;
};

function udpAsk(
  server: string,
  port: number,
  query: Buffer,
  id: number,
): Promise<WireAnswer> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(net.isIPv6(server) ? "udp6" : "udp4");
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error(`${server} did not answer`));
    }, ASK_TIMEOUT_MS);
    sock.on("error", (e) => {
      clearTimeout(timer);
      sock.close();
      reject(e);
    });
    sock.on("message", (msg) => {
      try {
        const a = decodeAnswer(msg);
        if (a.id !== id) return;
        clearTimeout(timer);
        sock.close();
        resolve(a);
      } catch {
        // Not an answer to this question: keep waiting for one.
      }
    });
    sock.send(query, port, server);
  });
}

function tcpAsk(
  server: string,
  port: number,
  query: Buffer,
): Promise<WireAnswer> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: server, port, timeout: ASK_TIMEOUT_MS });
    const chunks: Buffer[] = [];
    const len = Buffer.alloc(2);
    len.writeUInt16BE(query.length);
    sock.on("connect", () => sock.end(Buffer.concat([len, query])));
    sock.on("data", (d: Buffer) => chunks.push(d));
    sock.on("timeout", () =>
      sock.destroy(new Error(`${server} did not answer`)),
    );
    sock.on("error", reject);
    sock.on("close", () => {
      const all = Buffer.concat(chunks);
      if (all.length < 2)
        return reject(new Error(`${server} closed without answering`));
      try {
        resolve(decodeAnswer(all.subarray(2, 2 + all.readUInt16BE(0))));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Asks one name server one question, not recursively; over TCP when the UDP answer is truncated. */
export async function askNameServer(
  server: string,
  name: string,
  type: QType,
  port = 53,
): Promise<WireAnswer> {
  const id = randomInt(1, 0xffff);
  const query = encodeQuery(id, name, type);
  const a = await udpAsk(server, port, query, id);
  return a.truncated ? tcpAsk(server, port, query) : a;
}

/** The live way: the parent's name servers from this machine's resolver, asked on port 53. */
export const liveDelegationDeps: DelegationDeps = {
  async parentOf(zone) {
    const labels = zone.split(".");
    for (let i = 1; i < labels.length; i++) {
      const parent = labels.slice(i).join(".");
      const names = await dnsp.resolveNs(parent).catch(() => [] as string[]);
      if (names.length === 0) continue;
      const servers: string[] = [];
      for (const n of names.slice(0, 4))
        servers.push(
          ...(await dnsp.resolve4(n).catch(() => [] as string[])).slice(0, 1),
        );
      return servers.length > 0 ? { zone: parent, servers } : null;
    }
    return null;
  },
  ask: (server, name, type) => askNameServer(server, name, type),
};

const sameName = (a: string, b: string) =>
  a.replace(/\.$/, "") === b.replace(/\.$/, "");

let testDeps: DelegationDeps | null = null;
export function __setDelegationDepsForTest(d: DelegationDeps | null): void {
  testDeps = d;
}

/** Checks a zone's delegation at its parent and that each of the cluster's name servers answers for it. */
export async function checkDelegation(
  zone: string,
  expected: ExpectedNameServer[],
  deps: DelegationDeps = testDeps ?? liveDelegationDeps,
): Promise<DelegationCheck> {
  const problems: string[] = [];
  const parent = await deps.parentOf(zone).catch(() => null);
  let referral: WireAnswer | null = null;
  let asked: string | null = null;
  for (const server of parent?.servers ?? []) {
    referral = await deps.ask(server, zone, "NS").catch(() => null);
    if (referral) {
      asked = server;
      break;
    }
  }
  if (!parent)
    problems.push(
      `Deplo could not find who answers for the domain above ${zone}.`,
    );
  else if (!referral)
    problems.push(`The name servers of ${parent.zone} did not answer.`);
  else {
    const ns = [...referral.authority, ...referral.answer]
      .filter((r) => r.type === QTYPE.NS && sameName(r.name, zone))
      .map((r) => r.data);
    const glue = referral.additional.filter(
      (r) => r.type === QTYPE.A || r.type === QTYPE.AAAA,
    );
    if (ns.length === 0)
      problems.push(`${zone} is not delegated yet: add its NS records.`);
    for (const e of expected) {
      if (ns.length > 0 && !ns.some((n) => sameName(n, e.name)))
        problems.push(`Add the NS record ${zone} → ${e.name}.`);
      if (ns.length === 0) continue;
      const have = glue.filter((g) => sameName(g.name, e.name));
      for (const a of e.v4)
        if (!have.some((g) => g.type === QTYPE.A && g.data === a))
          problems.push(`Add the A record ${e.name} → ${a}.`);
      for (const a of e.v6)
        if (!have.some((g) => g.type === QTYPE.AAAA && g.data === a))
          problems.push(`Add the AAAA record ${e.name} → ${a}.`);
      for (const g of have)
        if (![...e.v4, ...e.v6].includes(g.data))
          problems.push(
            `${e.name} also points at ${g.data}: remove that record.`,
          );
    }
    for (const n of ns)
      if (!expected.some((e) => sameName(e.name, n)))
        problems.push(
          `${zone} also names ${n} as a name server: remove that NS record.`,
        );
    const ds = asked
      ? await deps.ask(asked, zone, "DS").catch(() => null)
      : null;
    if (ds?.answer.some((r) => r.type === QTYPE.DS))
      problems.push(
        `Remove the DS record of ${zone}: Deplo does not sign the zone, so resolvers would refuse it.`,
      );
  }
  const nameServers: DelegationCheck["nameServers"] = [];
  for (const e of expected) {
    const address = e.v4[0] ?? e.v6[0];
    if (!address) continue;
    const soa = await deps.ask(address, zone, "SOA").catch(() => null);
    const answers =
      soa != null &&
      soa.rcode === 0 &&
      soa.authoritative &&
      soa.answer.some((r) => r.type === QTYPE.SOA);
    nameServers.push({ name: e.name, address, answers });
  }
  return {
    delegated: parent != null && referral != null && problems.length === 0,
    parent: parent?.zone ?? null,
    problems,
    nameServers,
  };
}
