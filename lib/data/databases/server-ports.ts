import "server-only";

import { listServersForTeam, canHostWorkloads } from "../servers/roster";
import { requireActiveTeamId, canExposePorts } from "../../membership";
import { connectAgent } from "../../infra/agent-client/connect";
import { mapCheckPortUnsupported } from "../../infra/agent-client/errors";
import { MAX_PORT } from "../../databases/ports";
import { hostPortClaimed } from "../host-ports";

const EXPOSE_PORT_MIN = 20000;
const EXPOSE_PORT_MAX = 40000;

// resolveTeamServer - the server a team may provision/reroute a database on: it
// must exist, be visible to the team, and be provisioned.
export async function resolveTeamServer(teamId: string, serverId?: string) {
  // A specialised host runs no workload: storage-only has no Docker at all, and
  // build-only compiles for other machines and has no proxy.
  const servers = (await listServersForTeam(teamId)).filter(canHostWorkloads);
  if (servers.length === 0) throw new Error("No server available");
  let server;
  if (serverId) {
    server = servers.find((s) => s.id === serverId);
    if (!server) throw new Error("Selected server not found");
  } else if (servers.length === 1) {
    server = servers[0];
  } else {
    throw new Error("Select a server first");
  }
  if (!server.agent?.certFingerprint)
    throw new Error(`Server ${server.name} is not provisioned yet`);
  return server;
}

async function isHostPortFree(
  serverId: string,
  port: number,
): Promise<boolean> {
  const conn = await connectAgent(serverId);
  try {
    const res = await conn.checkPort(port);
    return res.available;
  } catch (e) {
    throw mapCheckPortUnsupported(e);
  } finally {
    conn.close();
  }
}

// portClaimedByAnotherDatabase - whether another ROW already holds this host
// port on this server; an app that publishes it counts.
async function portClaimedByAnotherDatabase(
  serverId: string,
  port: number,
  exceptId?: string,
): Promise<boolean> {
  return hostPortClaimed(serverId, port, { databaseId: exceptId });
}

// assertHostPortAvailable - nothing is listening on it right now, AND no other
// database row has already reserved it.
export async function assertHostPortAvailable(
  server: { id: string; name: string },
  port: number,
  exceptId?: string,
): Promise<void> {
  if (
    (await portClaimedByAnotherDatabase(server.id, port, exceptId)) ||
    !(await isHostPortFree(server.id, port))
  )
    throw new Error(
      `Port ${port} is already in use on ${server.name}. Pick a different port.`,
    );
}

// hostPortsInUse - which of these host ports are taken, for a screen that wants
// to say so BEFORE anything is created (the import review).
export async function hostPortsInUse(
  serverId: string,
  ports: number[],
): Promise<{ checked: boolean; inUse: number[]; reason: string | null }> {
  const teamId = await requireActiveTeamId();
  if (!(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");
  const server = await resolveTeamServer(teamId, serverId);

  // ANY real TCP port, not only the ones a user may ask for: 80 and 443 belong
  // to the proxy, so an imported reverse proxy is what this has to catch.
  const wanted = [...new Set(ports)]
    .filter((p) => Number.isInteger(p) && p >= 1 && p <= MAX_PORT)
    .slice(0, 50);
  const inUse: number[] = [];
  for (const port of wanted) {
    if (await portClaimedByAnotherDatabase(server.id, port)) {
      inUse.push(port);
      continue;
    }
    try {
      if (!(await isHostPortFree(server.id, port))) inUse.push(port);
    } catch (e) {
      return {
        checked: false,
        inUse: [],
        reason:
          e instanceof Error
            ? e.message
            : "Deplo could not check ports on this server.",
      };
    }
  }
  return { checked: true, inUse, reason: null };
}

// generateAvailableDbPort - a currently-free host port from the high ephemeral
// range. Only a SUGGESTION: creation re-checks it, so the race is caught there.
export async function generateAvailableDbPort(input: {
  serverId?: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  if (!(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");
  const server = await resolveTeamServer(teamId, input.serverId);

  // Start at a random offset so repeated clicks (and concurrent callers) don't
  // all probe the same candidate first.
  const span = EXPOSE_PORT_MAX - EXPOSE_PORT_MIN + 1;
  const start = Math.floor(Math.random() * span);
  const MAX_TRIES = 40;
  for (let i = 0; i < MAX_TRIES; i++) {
    const candidate = EXPOSE_PORT_MIN + ((start + i * 733) % span);
    if (await isHostPortFree(server.id, candidate)) return candidate;
  }
  throw new Error(
    "Could not find a free port on this server automatically. Enter one manually.",
  );
}
