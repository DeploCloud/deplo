import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { databases as databasesTable } from "../db/schema/control-plane";
import { requireActiveTeamId, requireCapability } from "../membership";
import { loadDatabaseForTeam } from "./databases";
import {
  connectAgent,
  AgentUnreachableError,
  type AgentConnection,
  type AgentConsoleInstance,
} from "../infra/agent-client";
import {
  DB_DATA_DIRS,
  effectiveDatabaseImage,
} from "../deploy/database-compose";
import { isDockerLevelStderr } from "../infra/docker";
import type {
  AppRuntime,
  ConsoleInfo,
  ConsoleInstance,
  LogsInfo,
  RuntimeContainer,
} from "./console";
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

/* ------------------------------------------------------------------ */
/* Console / logs seams                                                 */
/* ------------------------------------------------------------------ */

/** The database's 0-or-1 attachable containers, straight from the owning agent. */
async function listDatabaseInstances(db: Database): Promise<ConsoleInstance[]> {
  const conn = await connectAgent(db.serverId);
  try {
    const instances: AgentConsoleInstance[] = await conn.listInstances(
      db.id,
      db.host,
      "",
    );
    return instances;
  } finally {
    conn.close();
  }
}

/**
 * The honest not-running placeholder for a page render when the real list can't
 * be obtained (unreachable agent, or zero containers — including a pre-labels
 * container the agent can't see). Same display-only contract as console.ts's
 * displayFallback: the page loads and says "not running", never a fabricated
 * "running"; the operational paths still fail clearly.
 */
function displayFallback(db: Database): ConsoleInstance {
  return {
    name: db.host,
    service: db.host,
    image: effectiveDatabaseImage(db),
    running: false,
    exposed: false,
    user: "root",
    workdir: "/",
    openStdin: false,
    tty: false,
    // Unknown, not "stopped": this entry exists because we could not ask.
    state: "",
    health: "",
    restartCount: 0,
  };
}

async function listForDisplay(
  db: Database,
): Promise<{ instances: ConsoleInstance[]; real: boolean; unreachable: boolean }> {
  try {
    const instances = await listDatabaseInstances(db);
    return instances.length
      ? { instances, real: true, unreachable: false }
      : { instances: [displayFallback(db)], real: false, unreachable: false };
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return { instances: [displayFallback(db)], real: false, unreachable: true };
    throw e;
  }
}

/** Console page info for a database — same shape as an app's ConsoleInfo. */
export async function getDatabaseConsoleInfo(
  id: string,
): Promise<ConsoleInfo | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabaseForTeam(id, teamId);
  if (!db) return null;
  const { instances } = await listForDisplay(db);
  const def = instances[0];
  return {
    containerName: def.name,
    image: def.image,
    running: instances.some((i) => i.running),
    instances,
  };
}

/** Logs page info for a database — same shape as an app's LogsInfo. */
export async function getDatabaseLogsInfo(id: string): Promise<LogsInfo | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabaseForTeam(id, teamId);
  if (!db) return null;
  const found = await listForDisplay(db);
  return {
    running: found.instances.some((i) => i.running),
    streamable: found.real,
    unreachable: found.unreachable,
    instances: found.instances,
  };
}

/** The container's shell label for the console banner ("/bin/sh", "bash", or
 *  "raw exec (no shell)"). Degrades to raw when stopped/unreachable. */
export async function getDatabaseShellLabel(id: string): Promise<string> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabaseForTeam(id, teamId);
  if (!db) return "raw exec (no shell)";
  const { instances } = await listForDisplay(db);
  const pick = instances.find((i) => i.running);
  if (!pick) return "raw exec (no shell)";
  const conn = await connectAgent(db.serverId);
  try {
    return await conn.shellLabel(db.id, pick.name, pick.image);
  } catch (e) {
    if (e instanceof AgentUnreachableError) return "raw exec (no shell)";
    throw e;
  } finally {
    conn.close();
  }
}

/**
 * Authorise an attach and resolve the real container. Attaching stdin to the
 * live engine is an infra-class operation → `manage_infra` (databases have no
 * folder/deploy story; manage_infra is the capability every other database
 * mutation gates on). Same discriminated result contract as
 * console.ts's resolveAttachTarget.
 */
export async function resolveDatabaseAttachTarget(
  id: string,
  target?: string,
): Promise<
  | { ok: true; instance: ConsoleInstance; serverId: string }
  | { ok: false; reason: "not-found" | "no-instance" | "stopped" | "unreachable" }
> {
  const { teamId } = await requireCapability("manage_infra");
  const db = await loadDatabaseForTeam(id, teamId);
  if (!db) return { ok: false, reason: "not-found" };

  let instances: ConsoleInstance[];
  try {
    instances = await listDatabaseInstances(db);
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return { ok: false, reason: "unreachable" };
    throw e;
  }
  // Never trust a raw name from the client — the target must belong to this
  // database's stack.
  const pick = target
    ? instances.find((i) => i.name === target)
    : (instances.find((i) => i.running) ?? instances[0]);
  if (!pick) return { ok: false, reason: "no-instance" };
  if (!pick.running) return { ok: false, reason: "stopped" };
  return { ok: true, instance: pick, serverId: db.serverId };
}

/**
 * Authorise a logs stream and resolve the container. Reads are team-scoped
 * (parity with app logs — a viewer may read logs, never type into the engine).
 * Does NOT refuse a stopped container: `docker logs` still has its output.
 */
export async function resolveDatabaseLogsTarget(
  id: string,
  target?: string,
): Promise<
  | { ok: true; instance: ConsoleInstance; serverId: string }
  | { ok: false; reason: "not-found" | "no-instance" | "unreachable" }
> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabaseForTeam(id, teamId);
  if (!db) return { ok: false, reason: "not-found" };

  let instances: ConsoleInstance[];
  try {
    instances = await listDatabaseInstances(db);
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return { ok: false, reason: "unreachable" };
    throw e;
  }
  const pick = target
    ? instances.find((i) => i.name === target)
    : instances[0];
  if (!pick) return { ok: false, reason: "no-instance" };
  return { ok: true, instance: pick, serverId: db.serverId };
}

/**
 * Run one console line inside the database container. RCE into the engine →
 * `manage_infra` in the data layer (the GraphQL field carries the same scope —
 * defense in depth). Reuses console.ts's exec semantics verbatim: `exit`/
 * `logout` detach, `clear` is a form feed, docker-level stderr is classified
 * apart from the guest's own exit code, and an unreachable agent answers with
 * a clear line instead of throwing at the terminal.
 */
export async function execInDatabase(
  id: string,
  rawCommand: string,
): Promise<{ output: string; detach?: boolean }> {
  const { teamId } = await requireCapability("manage_infra");
  const db = await loadDatabaseForTeam(id, teamId);
  if (!db) return { output: "Error: database not found" };

  const command = rawCommand.trim();
  if (!command) return { output: "" };
  if (command === "exit" || command === "logout")
    return { output: "session closed", detach: true };
  if (command === "clear") return { output: "\f" };

  try {
    const instances = await listDatabaseInstances(db);
    const pick = instances.find((i) => i.running) ?? instances[0];
    if (!pick) return { output: "! no container on the host — redeploy the database" };

    const conn = await connectAgent(db.serverId);
    let res;
    try {
      res = await conn.exec(db.id, pick.name, command, pick.image);
    } finally {
      conn.close();
    }

    if (isDockerLevelStderr(res.stderr)) {
      const reason = res.stderr.trim() || `docker exec failed (exit ${res.code})`;
      return { output: `! ${reason}` };
    }
    const body = [res.stdout, res.stderr]
      .filter(Boolean)
      .join("\n")
      .replace(/\n+$/, "");
    if (res.code !== 0) {
      const hint = `[exit ${res.code}]`;
      return { output: body ? `${body}\n${hint}` : hint };
    }
    return { output: body };
  } catch (e) {
    if (e instanceof AgentUnreachableError) {
      return { output: `! Server unreachable: ${e.message}` };
    }
    return {
      output: `! ${e instanceof Error ? e.message : "command failed"}`,
    };
  }
}
