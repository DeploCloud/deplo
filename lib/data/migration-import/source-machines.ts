import "server-only";

import { desc, eq } from "drizzle-orm";
import { lookup } from "node:dns/promises";

import { getDb } from "../../db/client";
import { migrationSourceAddresses as sourceAddressesTable } from "../../db/schema/control-plane/migration";
import { nowIso } from "../../ids";
import { mapLimit } from "../../utils";
import { sourceAgentReachable } from "../agent-reach";
import { isCloudflareIp } from "../../deploy/cloudflare";
import { requireActiveTeamId } from "../../membership";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import { updateServerAddress } from "../servers/agent-maintenance";
import { listServersForTeam } from "../servers/roster";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import { servicesOf, type SourceService } from "./source-tree";

export interface PlanServer {
  sourceId: string;
  name: string;
  ipAddress: string | null;
  cloudflare: boolean;
  deploServerId: string | null;
  deploServerName: string | null;
  deploServerOnline: boolean;
}

export async function migrationMachines(
  c: SourceCredential,
  teamId: string,
  only?: Set<string>,
): Promise<PlanServer[]> {
  return planMachines(
    c,
    teamId,
    await sourceClient(c)
      .listServers()
      .catch(() => []),
    { only },
  );
}

export async function machinesHolding(
  c: SourceCredential,
  serviceIds: Iterable<string>,
): Promise<Set<string>> {
  const wanted = new Set(serviceIds);
  const stubs: SourceService[] = [];
  for (const p of await sourceClient(c).listProjects())
    for (const env of p.environments ?? [])
      for (const svc of servicesOf(env))
        if (wanted.has(svc.id)) stubs.push(svc);
  const out = new Set<string>();
  await mapLimit(stubs, 5, async (svc) => {
    const detail = await sourceClient(c)
      .getService(svc.kind, svc.id)
      .catch(() => null);
    out.add(detail?.serverId?.trim() || svc.serverId);
  });
  return out;
}

export async function rememberedAddresses(
  teamId: string,
  sourceUrl: string,
): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({
      teamId: sourceAddressesTable.teamId,
      sourceId: sourceAddressesTable.sourceId,
      address: sourceAddressesTable.address,
    })
    .from(sourceAddressesTable)
    .where(eq(sourceAddressesTable.sourceUrl, sourceUrl))
    .orderBy(desc(sourceAddressesTable.updatedAt));
  const out = new Map<string, string>();
  for (const r of [
    ...rows.filter((r) => r.teamId === teamId),
    ...rows.filter((r) => r.teamId !== teamId),
  ])
    if (!out.has(r.sourceId)) out.set(r.sourceId, r.address);
  return out;
}

export async function rememberMigrationMachineAddress(
  sourceUrl: string,
  sourceId: string,
  address: string,
): Promise<void> {
  const teamId = await requireActiveTeamId();
  const value = address.trim();
  if (!value) throw new Error("Address is required");
  await getDb()
    .insert(sourceAddressesTable)
    .values({
      teamId,
      sourceUrl,
      sourceId,
      address: value,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [
        sourceAddressesTable.teamId,
        sourceAddressesTable.sourceUrl,
        sourceAddressesTable.sourceId,
      ],
      set: { address: value, updatedAt: nowIso() },
    });
}

export async function setMigrationMachineAddress(input: {
  sourceUrl: string;
  sourceId: string;
  serverId: string;
  address: string;
}): Promise<{ warning: string | null }> {
  const { warning } = await updateServerAddress({
    id: input.serverId,
    address: input.address,
    keepHost: true,
  });
  await rememberMigrationMachineAddress(
    input.sourceUrl,
    input.sourceId,
    input.address,
  );
  return { warning };
}

let dnsLookup: (name: string) => Promise<{ address: string }[]> = (name) =>
  lookup(name, { all: true });

export function __setDnsLookupForTest(
  fn: (name: string) => Promise<{ address: string }[]>,
): void {
  dnsLookup = fn;
}

export function __resetDnsLookupForTest(): void {
  dnsLookup = (name) => lookup(name, { all: true });
}

async function resolveAddresses(
  candidates: (string | null | undefined)[],
  self: Set<string>,
): Promise<{ mine: Set<string>; cloudflare: Set<string> }> {
  const mine = new Set<string>();
  const cloudflare = new Set<string>();
  const wanted = [
    ...new Set(
      candidates
        .map((a) => a?.trim().toLowerCase())
        .filter((a): a is string => Boolean(a)),
    ),
  ];
  await mapLimit(wanted, 8, async (a) => {
    if (isDeploHostServer({ ip: a, host: a }, self)) {
      mine.add(a);
      return;
    }
    try {
      const hits = await dnsLookup(a);
      if (hits.some((h) => self.has(h.address.toLowerCase()))) mine.add(a);
      if (hits.some((h) => isCloudflareIp(h.address))) cloudflare.add(a);
    } catch {}
  });
  return { mine, cloudflare };
}

export async function planMachines(
  c: SourceCredential,
  teamId: string,
  servers: { serverId: string; name: string; ipAddress?: string | null }[],
  opts: {
    probe?: boolean;
    only?: Set<string>;
  } = {},
): Promise<PlanServer[]> {
  const mine = (await listServersForTeam(teamId)).filter((s) => !s.storageOnly);
  const byId = new Map(mine.map((s) => [s.id, s] as const));
  const self = deploHostSelfAddresses();
  const remembered = await rememberedAddresses(teamId, c.baseUrl);
  let ownAddress: string | null = null;
  try {
    ownAddress = new URL(c.baseUrl).hostname;
  } catch {}
  const resolved = await resolveAddresses(
    [
      ownAddress,
      ...servers.map((s) => s.ipAddress),
      ...remembered.values(),
      ...mine.flatMap((s) => [s.ip, s.host]),
    ],
    self,
  );
  const isSelf = (address: string | null | undefined) => {
    const a = address?.trim().toLowerCase();
    return Boolean(a && resolved.mine.has(a));
  };
  const at = (address: string | null) => {
    const a = address?.trim().toLowerCase();
    if (!a) return null;
    const hit =
      mine.find(
        (s) =>
          s.ip?.trim().toLowerCase() === a ||
          s.host?.trim().toLowerCase() === a,
      ) ??
      (isSelf(a)
        ? mine.find((s) => isDeploHostServer(s, self) || isSelf(s.ip ?? s.host))
        : undefined);
    return hit ? { deploServerId: hit.id, deploServerName: hit.name } : null;
  };

  const machine = (sourceId: string, name: string, derived: string | null) => {
    const address = remembered.get(sourceId) ?? derived;
    return {
      sourceId,
      name,
      ipAddress: address,
      cloudflare: Boolean(
        address && resolved.cloudflare.has(address.trim().toLowerCase()),
      ),
      deploServerId: null as string | null,
      deploServerName: null as string | null,
      ...(at(address) ?? at(derived) ?? {}),
    };
  };

  const rows = [
    machine("", `The ${sourceClient(c).displayName} host`, ownAddress),
    ...servers.map((s) => machine(s.serverId, s.name, s.ipAddress ?? null)),
  ].filter((m) => !opts.only || opts.only.has(m.sourceId));

  const matched = opts.probe
    ? [
        ...new Set(
          rows.flatMap((m) => (m.deploServerId ? [m.deploServerId] : [])),
        ),
      ]
    : [];
  const answered = new Map<string, boolean>();
  await mapLimit(matched, 4, async (id) => {
    answered.set(id, await sourceAgentReachable(id));
  });

  return rows.map((m) => {
    const hit = m.deploServerId ? byId.get(m.deploServerId) : null;
    return {
      ...m,
      deploServerOnline: hit
        ? opts.probe
          ? (answered.get(hit.id) ?? false)
          : Boolean(hit.statusCheckedAt) && hit.status === "online"
        : false,
    };
  });
}
