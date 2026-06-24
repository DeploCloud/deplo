import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import type { DbTx } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane";
import type { Server } from "../types";

/**
 * Bridge for the `servers` table during the project-graph migration window
 * (relational-store PLAN cut-set (c)).
 *
 * `servers` is NOT migrated by any cut-set (it is instance-wide infra, owned by
 * the still-JSONB `servers.ts`), but `projects.server_id` is a relational
 * NOT-NULL FK (`ON DELETE RESTRICT`) to it. The project-graph backfill seeds the
 * relational `servers` rows from the JSONB at switch time, but a server added
 * AFTER that — through the JSONB `addServer` — would have no relational row, so a
 * project created on it would FK-violate.
 *
 * Resolution (same shape as cut-set (b)'s `team-order` stub): the JSONB
 * `servers.ts` mirror-writes a MINIMAL relational `servers` row on create/update
 * and drops it on remove, so a project's `server_id` FK always resolves. The
 * JSONB row stays authoritative for everything else (status, agent trust, live
 * metrics); only the columns the FK + a future server cut-set need are mirrored.
 * A later server cut-set retires this bridge.
 */

/** Upsert the relational `servers` row mirroring a JSONB {@link Server}. */
export async function ensureServerRow(
  server: Server,
  db: ReturnType<typeof getDb> | DbTx = getDb(),
): Promise<void> {
  const row = {
    id: server.id,
    name: server.name,
    host: server.host,
    type: server.type,
    status: server.status,
    ip: server.ip,
    dockerVersion: server.dockerVersion,
    traefikEnabled: server.traefikEnabled,
    cpuCores: server.cpuCores,
    memoryMb: server.memoryMb,
    diskGb: server.diskGb,
    cpuUsage: server.cpuUsage,
    memoryUsage: server.memoryUsage,
    diskUsage: server.diskUsage,
    agentPort: server.agent?.port ?? null,
    agentCertFingerprint: server.agent?.certFingerprint ?? null,
    agentCertPem: server.agent?.certPem ?? null,
    agentVersion: server.agent?.version ?? null,
    bootstrapTokenHash: server.bootstrap?.tokenHash ?? null,
    bootstrapExpiresAt: server.bootstrap?.expiresAt ?? null,
    bootstrapUsedAt: server.bootstrap?.usedAt ?? null,
    lastSeenAt: server.lastSeenAt ?? null,
    createdAt: server.createdAt,
  };
  await db
    .insert(serversTable)
    .values(row)
    .onConflictDoUpdate({ target: serversTable.id, set: row });
}

/** Drop the relational `servers` row for a removed server. */
export async function deleteServerRow(
  id: string,
  db: ReturnType<typeof getDb> | DbTx = getDb(),
): Promise<void> {
  await db.delete(serversTable).where(eq(serversTable.id, id));
}
