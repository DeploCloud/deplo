import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { databases as databasesTable } from "../db/schema/control-plane";
import { requireActiveTeamId } from "../membership";
import { loadDatabaseForTeam } from "./databases";
import {
  connectAgent,
  AgentUnreachableError,
  type AgentConnection,
} from "../infra/agent-client";
import {
  DB_DATA_DIRS,
  effectiveDatabaseImage,
} from "../deploy/database-compose";
import type { AppRuntime, RuntimeContainer } from "./console";
import type { Database } from "../types";

/**
 * The database twin of `lib/data/console.ts` — runtime truth (and, in later
 * steps, console/logs seams) for a DATABASE container. Deliberately separate:
 * console.ts resolves through the app graph (loadTeamApp, compose services,
 * primary domains), none of which exists for a database. The agent RPCs
 * underneath are container-generic; only the authorization + instance
 * resolution differ.
 *
 * A database's container is discoverable through the same `deplo.project=<id>`
 * label the app stacks carry — stamped by generateDatabaseCompose since the
 * detail-page work. A container provisioned BEFORE the labels existed is
 * invisible to listInstances until its next reroute ("Redeploy"); the overview
 * surfaces that as a callout rather than a silently dead terminal.
 */

/** {@link AppRuntime} plus the database's live on-disk data size. */
export interface DatabaseRuntime extends AppRuntime {
  /**
   * The data volume's observed size in MiB (a `du -sm` probe of the engine's
   * data dir inside the running container), or null when it can't be known
   * (stopped, unreachable, probe failed). NEVER fabricated — null renders "—".
   */
  dataSizeMb: number | null;
}

/**
 * Same burst-absorbing TTL as the app runtime probe: the detail header and the
 * storage cards can poll the same database concurrently.
 */
const RUNTIME_TTL_MS = 3_000;
const runtimeCache = new Map<string, { at: number; value: DatabaseRuntime }>();

/**
 * The size probe is an exec (`du -sm`) into the live container — much heavier
 * than a container list, and data size moves slowly. Held for a minute.
 */
const SIZE_TTL_MS = 60_000;
const sizeCache = new Map<string, { at: number; value: number | null }>();

/**
 * Live container truth for one database, team-scoped. Null = not found (not
 * "no containers" — that's `total: 0` with `unreachable: false`).
 */
export async function getDatabaseRuntime(
  id: string,
): Promise<DatabaseRuntime | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabaseForTeam(id, teamId);
  if (!db) return null;

  const hit = runtimeCache.get(db.id);
  if (hit && Date.now() - hit.at < RUNTIME_TTL_MS) return hit.value;

  const value = await probeRuntime(db);
  runtimeCache.set(db.id, { at: Date.now(), value });
  return value;
}

async function probeRuntime(db: Database): Promise<DatabaseRuntime> {
  let conn: AgentConnection;
  try {
    conn = await connectAgent(db.serverId);
  } catch {
    return unknownDatabaseRuntime();
  }
  try {
    const instances = await conn.listInstances(db.id, db.host, "");
    const containers: RuntimeContainer[] = instances.map((i) => ({
      name: i.name,
      service: i.service,
      state: i.state,
      health: i.health,
      restartCount: i.restartCount,
      running: i.running,
      exposed: i.exposed,
    }));
    // A database declares exactly one service, named after its host slug. No
    // container for it = missing — the state `docker ps` can't show.
    const present = new Set(containers.map((c) => c.service));
    const missing = [db.host].filter((s) => !present.has(s));
    const anyRunning = containers.some((c) => c.running);

    return {
      total: containers.length,
      running: containers.filter((c) => c.running).length,
      restarting: containers.filter((c) => c.state === "restarting").length,
      unhealthy: containers.filter((c) => c.running && c.health === "unhealthy")
        .length,
      missing,
      containers,
      unreachable: false,
      // Only a live engine can answer `du`; a stopped DB keeps its last cached
      // answer (if fresh) and otherwise honestly answers null.
      dataSizeMb: anyRunning
        ? await probeDataSize(conn, db)
        : (freshSizeFor(db.id) ?? null),
    };
  } catch (e) {
    if (e instanceof AgentUnreachableError) return unknownDatabaseRuntime();
    throw e;
  } finally {
    conn.close();
  }
}

function freshSizeFor(id: string): number | null | undefined {
  const hit = sizeCache.get(id);
  return hit && Date.now() - hit.at < SIZE_TTL_MS ? hit.value : undefined;
}

/**
 * `du -sm <data dir>` inside the running container — every official engine
 * image ships a shell + coreutils. Cached for a minute; null on ANY failure
 * (custom image without `du`, agent too old for exec, permission error).
 * The observed value is written back to `databases.size_mb` fire-and-forget
 * (best-effort, like markServerSeen) so list surfaces show a last-observed
 * size without dialing an agent per card.
 */
async function probeDataSize(
  conn: AgentConnection,
  db: Database,
): Promise<number | null> {
  const fresh = freshSizeFor(db.id);
  if (fresh !== undefined) return fresh;
  let value: number | null = null;
  try {
    const res = await conn.exec(
      db.id,
      db.host,
      `du -sm ${DB_DATA_DIRS[db.type]}`,
      effectiveDatabaseImage(db),
    );
    const m = /^(\d+)\b/.exec(res.stdout.trim());
    value = res.code === 0 && m ? Number(m[1]) : null;
  } catch {
    value = null;
  }
  sizeCache.set(db.id, { at: Date.now(), value });
  if (value != null && value !== db.sizeMb) {
    void getDb()
      .update(databasesTable)
      .set({ sizeMb: value })
      .where(eq(databasesTable.id, db.id))
      .then(
        () => {},
        () => {},
      );
  }
  return value;
}

function unknownDatabaseRuntime(): DatabaseRuntime {
  return {
    total: 0,
    running: 0,
    restarting: 0,
    unhealthy: 0,
    missing: [],
    containers: [],
    unreachable: true,
    dataSizeMb: null,
  };
}
