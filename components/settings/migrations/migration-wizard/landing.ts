import {
  importableOf,
  type Placement,
  type Plan,
  type ServerChoice,
} from "../types";

// OWN_HOST - the source panel's own host has no server row over there; it is the empty id.
export const OWN_HOST = "";

// FleetServer - a server as the fleet query lists it; `role` "everything" is one that runs.
export interface FleetServer {
  id: string;
  name: string;
  role: string;
  isDeploHost: boolean;
}

// Fleet - what one landing team may place services on.
export interface Fleet {
  servers: ServerChoice[];
  buildServers: ServerChoice[];
}

// defaultChoice - what a fresh plan arrives ticked with: everything Deplo can create that is not here yet.
export function defaultChoice(plan: Plan): Set<string> {
  return new Set(
    plan.projects.flatMap((p) =>
      importableOf(p)
        .filter((s) => s.status !== "exists")
        .map((s) => s.sourceId),
    ),
  );
}

// landingDefaults - where each service lands unless somebody says otherwise: the Deplo server that IS its machine.
export function landingDefaults(
  scanned: Plan,
  servers: ServerChoice[],
): { placements: Record<string, Placement>; servers: Record<string, string> } {
  const home = (servers.find((s) => s.isDeploHost) ?? servers[0])?.id;
  if (!home) return { placements: {}, servers: {} };
  const runnable = new Set(servers.map((s) => s.id));
  const byMachine = new Map(
    scanned.servers.map((m) => [
      m.sourceId,
      m.deploServerId && runnable.has(m.deploServerId) ? m.deploServerId : home,
    ]),
  );
  const landingFor = (sourceServerId: string) =>
    byMachine.get(sourceServerId) ?? home;
  return {
    placements: Object.fromEntries(
      scanned.projects.flatMap((p) =>
        importableOf(p).map((svc) => [
          svc.sourceId,
          { serverId: landingFor(svc.sourceServerId), buildServerId: null },
        ]),
      ),
    ),
    // Only where its apps LAND: where the data is READ from is derived
    // server-side from the machine's address, never from this map.
    servers: Object.fromEntries([
      [OWN_HOST, landingFor(OWN_HOST)],
      ...scanned.servers.map((s) => [s.sourceId, landingFor(s.sourceId)]),
    ]),
  };
}

// reconcilePlacements - drop a placement the landing team's fleet no longer offers.
export function reconcilePlacements(
  placements: Record<string, Placement>,
  machines: Record<string, string>,
  servers: ServerChoice[],
  buildServers: ServerChoice[],
): { placements: Record<string, Placement>; servers: Record<string, string> } {
  const home = (servers.find((s) => s.isDeploHost) ?? servers[0])?.id;
  if (!home) return { placements, servers: machines };
  const runnable = new Set(servers.map((s) => s.id));
  const buildable = new Set(buildServers.map((s) => s.id));
  return {
    placements: Object.fromEntries(
      Object.entries(placements).map(([id, p]) => [
        id,
        {
          ...p,
          serverId: runnable.has(p.serverId) ? p.serverId : home,
          // Null is Automatic, which is the right answer for a host that is gone.
          buildServerId:
            p.buildServerId && !buildable.has(p.buildServerId)
              ? null
              : p.buildServerId,
        },
      ]),
    ),
    servers: Object.fromEntries(
      Object.entries(machines).map(([from, to]) => [
        from,
        runnable.has(to) ? to : home,
      ]),
    ),
  };
}
