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

// PlanServer - one machine behind the panel, and whether Deplo can reach its disk:
// a volume is copied by asking the agent ON the host that holds it (ADR-0006), and
// agents cannot dial each other.
export interface PlanServer {
  sourceId: string;
  name: string;
  ipAddress: string | null;
  // That address resolves into Cloudflare's proxy ranges, so it answers as the proxy
  // and Deplo can never dial an agent on it.
  cloudflare: boolean;
  // The Deplo server sitting at that address, when there is one.
  deploServerId: string | null;
  deploServerName: string | null;
  // Whether that server can actually be READ. A row a failed first attempt left behind
  // sits at the same address, and taking it for a connected machine made the retry skip
  // the install step and die in the data phase.
  deploServerOnline: boolean;
}

// migrationMachines - every machine behind the panel, each paired with the Deplo
// server at the same address, or nothing when Deplo has no agent there.
export async function migrationMachines(
  c: SourceCredential,
  teamId: string,
  // Only these machines (source ids) - see `planMachines`.
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

// machinesHolding - the machines (source ids, `""` for the panel's own host) these
// services run on: the only agents a run needs.
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
  // The detail row, not the tree: `project.all` carries no server, so every
  // service on a second host reads as the panel's own there.
  await mapLimit(stubs, 5, async (svc) => {
    const detail = await sourceClient(c)
      .getService(svc.kind, svc.id)
      .catch(() => null);
    out.add(detail?.serverId?.trim() || svc.serverId);
  });
  return out;
}

// The addresses somebody has already corrected for this panel, by machine. Read
// across teams: the machine is where it is whoever imports from it.
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
  // Newest first, this team's own answer before anybody else's.
  for (const r of [
    ...rows.filter((r) => r.teamId === teamId),
    ...rows.filter((r) => r.teamId !== teamId),
  ])
    if (!out.has(r.sourceId)) out.set(r.sourceId, r.address);
  return out;
}

// rememberMigrationMachineAddress - where a machine of this panel is reached, so the
// next attempt registers it there instead of at the panel's name. The last answer,
// which is the one somebody just proved, overwrites.
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

// setMigrationMachineAddress - point Deplo at where a machine really is, and remember it.
export async function setMigrationMachineAddress(input: {
  sourceUrl: string;
  sourceId: string;
  serverId: string;
  address: string;
}): Promise<{ warning: string | null }> {
  const { warning } = await updateServerAddress({
    id: input.serverId,
    address: input.address,
    // The panel's name stays in `host`: it is what pairs this row with the
    // Dokploy machine on a second pass. See the flag's own doc.
    keepHost: true,
  });
  await rememberMigrationMachineAddress(
    input.sourceUrl,
    input.sourceId,
    input.address,
  );
  return { warning };
}

// The one resolver the plan's machine matching goes through, swappable so the pglite
// suite stays hermetic. Production always uses node's.
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

// One resolution pass over every candidate address, answering both questions the plan
// has about it: is it THIS machine (a panel on the same box is typed as the name it is
// opened on), and does it resolve into Cloudflare's proxy ranges - the proxy, not a machine.
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
    } catch {
      /* a name nothing resolves is neither this machine nor behind a proxy */
    }
  });
  return { mine, cloudflare };
}

export async function planMachines(
  c: SourceCredential,
  teamId: string,
  servers: { serverId: string; name: string; ipAddress?: string | null }[],
  opts: {
    // Dial the agents whose reachability nothing has ever measured. The wizard's
    // readiness needs it; a caller that only wants the id mapping does not.
    probe?: boolean;
    // Keep only these machines (source ids). A panel behind a proxy is not a machine to
    // install on when nothing of this team runs there.
    only?: Set<string>;
  } = {},
): Promise<PlanServer[]> {
  // Migration sources stay in this list on purpose: matching a machine to the
  // agent that can read its disks is the ONE lookup they exist for, and a second
  // pass of the same import has to find the one the first pass registered.
  const mine = (await listServersForTeam(teamId)).filter((s) => !s.storageOnly);
  const byId = new Map(mine.map((s) => [s.id, s] as const));
  const self = deploHostSelfAddresses();
  const remembered = await rememberedAddresses(teamId, c.baseUrl);
  let ownAddress: string | null = null;
  try {
    ownAddress = new URL(c.baseUrl).hostname;
  } catch {
    /* the client already normalised this; a bad one just matches nothing */
  }
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
      // The same-machine case: the other platform runs on the box Deplo runs on.
      (isSelf(a)
        ? mine.find((s) => isDeploHostServer(s, self) || isSelf(s.ip ?? s.host))
        : undefined);
    return hit ? { deploServerId: hit.id, deploServerName: hit.name } : null;
  };

  // A remembered correction wins over the derived address, and BOTH are tried for the match.
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

  // The row is MATCHED either way - that is what stops a second attempt
  // registering the same address twice - but only an agent that ANSWERS NOW
  // means the machine is ready: `status` goes green on the agent's own
  // call-home, and stays green after the agent is gone.
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
      // Without a probe (the data step's own lookups) the last DIALED verdict
      // stands; a row nothing ever dialed is not ready.
      deploServerOnline: hit
        ? opts.probe
          ? (answered.get(hit.id) ?? false)
          : Boolean(hit.statusCheckedAt) && hit.status === "online"
        : false,
    };
  });
}
