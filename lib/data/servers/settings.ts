import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { recordActivity } from "../activity";
import {
  assertNotMigrationSource,
  getServerById,
  requireAdminServer,
  serverRole,
  SERVER_ROLES,
  type ServerRole,
} from "./roster";
import { assertNoWorkloads } from "./removal";
import type { Server } from "../../types/server";

// Cap the display name like an App's, so a huge string can't ride every payload.
export const SERVER_NAME_MAX = 60;

export function cleanServerName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Server name is required.");
  if (trimmed.length > SERVER_NAME_MAX)
    throw new Error(
      `Server name must be ${SERVER_NAME_MAX} characters or fewer.`,
    );
  return trimmed;
}

// renameServer renames a server. Display only: nothing dials, routes or deploys by name.
export async function renameServer(id: string, name: string): Promise<Server> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const clean = cleanServerName(name);
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  const updated = await getDb()
    .update(serversTable)
    .set({ name: clean })
    .where(eq(serversTable.id, id))
    .returning({ name: serversTable.name });
  if (updated.length === 0) throw new Error("Server not found");
  await recordActivity(
    "server",
    `Renamed server ${server.name} to ${clean}`,
    user.name,
    null,
    teamId,
  );
  return (await getServerById(id))!;
}

// setServerRole changes what a server is for. The one true asymmetry is physical:
// a server INSTALLED as backups-only never had Docker put on it.
export async function setServerRole(
  id: string,
  role: ServerRole,
): Promise<Server> {
  await requireInstanceAdmin();
  // An unknown role must be refused: falling through would clear both flags and
  // put a build-only or backups-only host silently back into service.
  if (!SERVER_ROLES.includes(role))
    throw new Error(
      `Unknown server role "${role}". Pick "everything", "build" or "storage".`,
    );
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const current = serverRole(server);
  if (role === current) return server;

  // A migration source is not a role anyone picks: it is another platform's host,
  // where the installer put no Traefik and no shared network.
  if (current === "import")
    throw new Error(
      `${server.name} was installed only to import from another platform. ` +
        `Re-run the install command on the host to use it as a normal server.`,
    );
  if (role === "import")
    throw new Error(
      "A migration source is created by the import wizard, which installs the " +
        "agent on the other platform's host for you.",
    );

  // The physical one-way door: no Docker on the box, nothing to run or build with.
  if (current === "storage" && !server.dockerVersion)
    throw new Error(
      "This server was installed to hold backups only and has no Docker on it. " +
        "Re-run the install command on the host to change that.",
    );
  // Leaving "everything" means it stops serving what it serves today.
  if (current === "everything") await assertNoWorkloads(id);

  await getDb()
    .update(serversTable)
    .set({
      buildOnly: role === "build",
      storageOnly: role === "storage",
      importOnly: false,
    })
    .where(eq(serversTable.id, id));
  await recordActivity(
    "server",
    role === "build"
      ? `Set server ${server.name} to build only`
      : role === "storage"
        ? `Set server ${server.name} to hold backups only`
        : `Set server ${server.name} to run apps again`,
    user.name,
    null,
    teamId,
  );
  return (await getServerById(id))!;
}

// setServerBuildFallback decides whether this host compiles for an app whose own
// build server could not be reached. `null` is automatic: only the Deplo host does.
export async function setServerBuildFallback(
  id: string,
  buildFallback: boolean | null,
): Promise<Server> {
  const { teamId, user, server } = await requireAdminServer(id);
  if (buildFallback) {
    assertNotMigrationSource(server);
    if (server.storageOnly)
      throw new Error(
        `${server.name} holds backups only - it has no Docker to build with.`,
      );
  }
  await getDb()
    .update(serversTable)
    .set({ buildFallback })
    .where(eq(serversTable.id, id));
  await recordActivity(
    "server",
    buildFallback === null
      ? `Left ${server.name} to decide its build fallback automatically`
      : buildFallback
        ? `Set server ${server.name} to build as a fallback`
        : `Stopped server ${server.name} from building as a fallback`,
    user.name,
    null,
    teamId,
  );
  return (await getServerById(id))!;
}

// setServerDeployConcurrency sets how many deployments a server's agent runs at
// once (read by lib/deploy/deploy-queue); a same-app deploy never overlaps regardless.
export async function setServerDeployConcurrency(
  id: string,
  concurrency: number,
): Promise<Server> {
  const { teamId, user, server } = await requireAdminServer(id);
  const n = Math.floor(concurrency);
  if (!Number.isFinite(n) || n < 1)
    throw new Error("Concurrency must be a whole number of at least 1");
  if (n > 50) throw new Error("Concurrency above 50 isn't supported");
  await getDb()
    .update(serversTable)
    .set({ deployConcurrency: n })
    .where(eq(serversTable.id, id));
  await recordActivity(
    "server",
    `Set deploy concurrency for server ${server.name} to ${n}`,
    user.name,
    null,
    teamId,
  );
  return (await getServerById(id))!;
}
