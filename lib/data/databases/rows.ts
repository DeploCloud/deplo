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

// maskConnectionString - fails CLOSED: anything we cannot confidently parse is
// fully redacted rather than risk leaking the secret.
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

// mountsByDatabase - the config files of one or more databases, keyed by id and
// in stored order.
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

// mountsFor - the one database's config files, in stored order.
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

// loadDatabaseForTeam - one team-scoped database row, assembled, or null.
export async function loadDatabaseForTeam(
  id: string,
  teamId: string,
): Promise<Database | null> {
  return loadDatabase(id, teamId, { forRead: true });
}

// getDatabaseForTeam - cookie-free team-scoped DTO load, the `databaseStatus`
// subscription generator's only data edge (masked, no `connectionStringEnc`).
export async function getDatabaseForTeam(
  id: string,
  teamId: string,
): Promise<DatabaseDTO | null> {
  // The SESSION-FREE twin: its ticks run after the HTTP handler returned the
  // streaming Response, with no cookies left to read. The token scope is not a
  // cookie - yoga re-establishes it on every tick.
  if (narrowedScope()) return null;
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  if (!rows[0]) return null;
  return toDTO(assembleDatabase(rows[0], await mountsFor(rows[0].id)));
}

// loadDatabase - a database row for the active team, and - by default - a
// REFUSAL while a migration is still creating it. Reads as NOT FOUND rather than
// as a scope error, so a scope can never become an oracle for which ids exist.
export async function loadDatabase(
  id: string,
  teamId: string,
  opts: { forRead?: boolean } = {},
): Promise<Database | null> {
  // A database belongs to the team and to no project, so a principal who reaches
  // only part of the team reaches none of them.
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

// requireDatabase - {@link loadDatabase}, refusing an id the caller cannot reach.
export async function requireDatabase(
  id: string,
  teamId: string,
): Promise<Database> {
  const db = await loadDatabase(id, teamId);
  if (!db) throw new Error("Not found");
  return db;
}

// assertNotProvisioning - the compose project does not exist until provisioning
// finishes, so every lifecycle verb against one would fail confusingly.
export function assertNotProvisioning(db: Database, verb: string): void {
  if (db.status === "provisioning")
    throw new Error(
      `Database is still provisioning - wait for it to finish before ${verb}.`,
    );
}

// databaseExists - id-only existence probe, not team-scoped.
export async function databaseExists(id: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(eq(databasesTable.id, id))
    .limit(1);
  return rows.length > 0;
}

// databaseOrderRank - the team-wide manual order (`team_database_order`), id to rank.
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

// listDatabases - every database in the active team. `query` filters by name or
// id with the same match `listApps` and `search` use.
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
  // The team's manual order first, anything not listed falls back to
  // newest-first - the same rule the Overview apps grid uses.
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

// reorderDatabases - persist the team-wide order of the Storage grid. A dead id
// can't be stored (the FK CASCADE makes the self-healing a DB invariant).
export async function reorderDatabases(orderedIds: string[]): Promise<void> {
  const teamId = (await requireCapability("configure_databases")).teamId;
  await getDb().transaction(async (tx) => {
    // Newest-first, so a database the client omitted appends in a sensible,
    // deterministic order after the explicitly-ordered ones.
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
  // This returns the plaintext connection string (it embeds the DB password), so
  // it enforces the capability at the data-layer boundary itself rather than
  // leaning on the revealConnection field's authScope alone (keep BOTH gates).
  const { teamId } = await requireCapability("reveal_secrets");
  // A read: the credentials of a database still arriving are the same
  // credentials it will have, and somebody watching it land may want them.
  const db = await loadDatabase(id, teamId, { forRead: true });
  if (!db) throw new Error("Not found");
  return decryptSecret(db.connectionStringEnc);
}
