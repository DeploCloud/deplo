import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { narrowedScope } from "../../auth/request-context";
import {
  databaseMounts as databaseMountsTable,
  databases as databasesTable,
} from "../../db/schema/control-plane/databases";
import { teamDatabaseOrder } from "../../db/schema/control-plane/display-order";
import { assembleDatabase } from "../backup-rows";
import {
  reachesWholeTeam,
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../../membership";
import { matchesQuery } from "../../match-query";
import { decryptSecret } from "../../crypto";
import { assertNotMigrating } from "../migration-guard";
import type { Database, DatabaseMount } from "../../types/database";

export interface DatabaseDTO extends Omit<Database, "connectionStringEnc"> {
  connectionStringMasked: string;
}

function maskConnectionString(conn: string): string {
  const FULL_MASK = "••••••••••••";
  try {
    const u = new URL(conn);
    if (!u.password) return conn;
    const userPart = u.username ? `${u.username}:••••••@` : "••••••@";
    return `${u.protocol}//${userPart}${u.host}${u.pathname}`;
  } catch {
    return FULL_MASK;
  }
}

export async function mountsByDatabase(
  ids: string[],
): Promise<Map<string, DatabaseMount[]>> {
  const out = new Map<string, DatabaseMount[]>();
  if (ids.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(databaseMountsTable)
    .where(inArray(databaseMountsTable.databaseId, ids))
    .orderBy(databaseMountsTable.databaseId, databaseMountsTable.position);
  for (const r of rows) {
    const list = out.get(r.databaseId) ?? [];
    list.push({
      filePath: r.filePath,
      content: r.content,
      mountPath: r.mountPath,
    });
    out.set(r.databaseId, list);
  }
  return out;
}

export async function mountsFor(id: string): Promise<DatabaseMount[]> {
  return (await mountsByDatabase([id])).get(id) ?? [];
}

export function toDTO(db: Database): DatabaseDTO {
  const { connectionStringEnc, ...rest } = db;
  return {
    ...rest,
    connectionStringMasked: maskConnectionString(
      decryptSecret(connectionStringEnc),
    ),
  };
}

export async function loadDatabaseForTeam(
  id: string,
  teamId: string,
): Promise<Database | null> {
  return loadDatabase(id, teamId, { forRead: true });
}

export async function getDatabaseForTeam(
  id: string,
  teamId: string,
): Promise<DatabaseDTO | null> {
  if (narrowedScope()) return null;
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  if (!rows[0]) return null;
  return toDTO(assembleDatabase(rows[0], await mountsFor(rows[0].id)));
}

export async function loadDatabase(
  id: string,
  teamId: string,
  opts: { forRead?: boolean } = {},
): Promise<Database | null> {
  if (narrowedScope()) return null;
  if (!(await reachesWholeTeam())) return null;
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  if (!rows[0]) return null;
  if (!opts.forRead)
    assertNotMigrating("database", rows[0].name, rows[0].migrationRunId);
  return assembleDatabase(rows[0], await mountsFor(rows[0].id));
}

export async function requireDatabase(
  id: string,
  teamId: string,
): Promise<Database> {
  const db = await loadDatabase(id, teamId);
  if (!db) throw new Error("Not found");
  return db;
}

export function assertNotProvisioning(db: Database, verb: string): void {
  if (db.status === "provisioning")
    throw new Error(
      `Database is still provisioning - wait for it to finish before ${verb}.`,
    );
}

export async function databaseExists(id: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(eq(databasesTable.id, id))
    .limit(1);
  return rows.length > 0;
}

async function databaseOrderRank(teamId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({
      databaseId: teamDatabaseOrder.databaseId,
      position: teamDatabaseOrder.position,
    })
    .from(teamDatabaseOrder)
    .where(eq(teamDatabaseOrder.teamId, teamId));
  return new Map(rows.map((r) => [r.databaseId, r.position] as const));
}

export async function listDatabases(query?: string): Promise<DatabaseDTO[]> {
  await requireTeamWide("databases");
  const teamId = await requireActiveTeamId();
  const [rows, rank] = await Promise.all([
    getDb()
      .select()
      .from(databasesTable)
      .where(eq(databasesTable.teamId, teamId)),
    databaseOrderRank(teamId),
  ]);
  const mounts = await mountsByDatabase(rows.map((r) => r.id));
  return rows
    .map((r) => toDTO(assembleDatabase(r, mounts.get(r.id) ?? [])))
    .filter((d) => !query || matchesQuery(query, d.name, d.id))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

export async function reorderDatabases(orderedIds: string[]): Promise<void> {
  const teamId = (await requireCapability("configure_databases")).teamId;
  await getDb().transaction(async (tx) => {
    const teamDbIds = (
      await tx
        .select({ id: databasesTable.id })
        .from(databasesTable)
        .where(eq(databasesTable.teamId, teamId))
        .orderBy(desc(databasesTable.createdAt))
    ).map((r) => r.id);
    const valid = new Set(teamDbIds);
    const seen = new Set<string>();
    const next: string[] = [];
    for (const id of orderedIds) {
      if (valid.has(id) && !seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    }
    for (const id of teamDbIds) if (!seen.has(id)) next.push(id);
    await tx
      .delete(teamDatabaseOrder)
      .where(eq(teamDatabaseOrder.teamId, teamId));
    if (next.length > 0) {
      await tx.insert(teamDatabaseOrder).values(
        next.map((databaseId, position) => ({
          teamId,
          databaseId,
          position,
        })),
      );
    }
  });
}

export async function getDatabase(id: string): Promise<DatabaseDTO | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabase(id, teamId, { forRead: true });
  return db ? toDTO(db) : null;
}

export async function getConnectionString(id: string): Promise<string> {
  const { teamId } = await requireCapability("reveal_secrets");
  const db = await loadDatabase(id, teamId, { forRead: true });
  if (!db) throw new Error("Not found");
  return decryptSecret(db.connectionStringEnc);
}
