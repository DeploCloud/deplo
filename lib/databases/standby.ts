import type { ResourceLimits } from "../types/container";
import type { DatabaseType } from "../types/database";
import { formatBytes } from "../utils";
import { isOfficialEngineImage } from "./images";
import { mongodb } from "./standby-mongodb";
import { redis } from "./standby-redis";
import {
  LOGIN,
  marks,
  sh,
  type StandbyArgs,
  type StandbyEngine,
} from "./standby-shell";
import { mariadb, mysql } from "./standby-sql";

// How a cluster database keeps a standby copy (spec #176). The mechanism is engine-blind: one row here says how
// an engine makes a copy, promotes it and what it costs. https://deplo.build/docs/operations/clusters/standby-copy

export { standbyContainer } from "./standby-shell";
export type { StandbyArgs, StandbyEngine } from "./standby-shell";

const M = marks("$PGDATA");
const SEEDED = M.seeded;
const FOLLOWING = M.following;

function psql(a: StandbyArgs, sql: string, flags = "-v ON_ERROR_STOP=1") {
  return `psql ${flags} -U ${sh(a.username)} -d ${sh(a.dbName)} -c ${sh(sql)}`;
}

const postgres: StandbyEngine = {
  label: "PostgreSQL",
  minVersion: "13",
  kept: "Its own server keeps up to 1 GiB more.",
  prepare: (a) =>
    [
      "set -e",
      `hba=$(psql -U ${sh(a.username)} -d ${sh(a.dbName)} -Atc 'show hba_file')`,
      psql(
        a,
        `SET password_encryption = 'scram-sha-256'; ` +
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN}; END IF; END $$; ` +
          `ALTER ROLE ${LOGIN} WITH REPLICATION LOGIN PASSWORD '${a.password}'`,
      ),
      psql(a, "ALTER SYSTEM SET wal_keep_size = '1GB'"),
      `grep -q ' ${LOGIN} ' "$hba" || echo 'host replication ${LOGIN} all scram-sha-256' >> "$hba"`,
      psql(a, "SELECT pg_reload_conf()"),
    ].join("\n"),
  retire: (a) =>
    [
      `hba=$(psql -U ${sh(a.username)} -d ${sh(a.dbName)} -Atc 'show hba_file')`,
      // Rewritten in place: a replaced file would belong to root and lock the engine out.
      `[ -n "$hba" ] && kept=$(grep -v ' ${LOGIN} ' "$hba") && printf '%s\\n' "$kept" > "$hba"`,
      psql(a, "ALTER SYSTEM RESET wal_keep_size", ""),
      psql(a, "SELECT pg_reload_conf()", ""),
      psql(a, `DROP ROLE IF EXISTS ${LOGIN}`),
    ].join("\n"),
  start: (a) => {
    const primary = `-h ${a.primaryHost} -p ${a.port} -U ${LOGIN}`;
    const receiving = `psql -U ${sh(a.username)} -d ${sh(a.dbName)} -Atc "select count(*) from pg_stat_wal_receiver where status = 'streaming'" 2>/dev/null`;
    return {
      env: [
        `DEPLO_STANDBY_PASSWORD=${a.password}`,
        `DEPLO_STANDBY_SEED=${a.seed}`,
      ],
      command: [
        "sh",
        "-c",
        [
          "set -e",
          // ponytail: data an old database left here is overwritten; ticket #206 backs it up when its member returns.
          `if ${M.unseeded}; then`,
          `  find "$PGDATA" -mindepth 1 -delete`,
          `  PGPASSWORD="$DEPLO_STANDBY_PASSWORD" pg_basebackup ${primary} -D "$PGDATA" -X stream -R`,
          `  touch ${FOLLOWING}`,
          `  printf %s "$DEPLO_STANDBY_SEED" > ${SEEDED}`,
          "fi",
          `(while sleep 5; do if [ "$(${receiving})" = 1 ]; then touch ${FOLLOWING}; fi; done) &`,
          `exec docker-entrypoint.sh postgres -c "primary_conninfo=host=${a.primaryHost} port=${a.port} user=${LOGIN} password=$DEPLO_STANDBY_PASSWORD"`,
          "",
        ].join("\n"),
      ],
    };
  },
  check: M.check,
  promote: {
    user: "postgres",
    command: ["sh", "-c", `${M.refuse}; pg_ctl promote -w -t 90 -D "$PGDATA"`],
  },
};

/** One row per engine that can keep a standby copy. */
export const STANDBY_ENGINES: Partial<Record<DatabaseType, StandbyEngine>> = {
  postgres,
  mysql,
  mariadb,
  redis,
  mongodb,
};

/** Engines that never keep one, and why, as their page says it. */
const NEVER: Partial<Record<DatabaseType, string>> = {
  clickhouse:
    "ClickHouse keeps no standby copy: it copies data table by table through a coordination service Deplo does not run. A failover restores the latest backup.",
};

const supported = () =>
  Object.values(STANDBY_ENGINES)
    .map((e) => e.label)
    .join(", ");

/** Whether `version` is older than `floor`. A part the tag does not name ("8.0", "latest") is the newest of its line. */
function olderThan(version: string, floor: string): boolean {
  const have = version.split(".").map((p) => Number.parseInt(p, 10));
  for (const [i, want] of floor.split(".").map(Number).entries()) {
    const part = have[i];
    if (part === undefined || !Number.isFinite(part)) return false;
    if (part !== want) return part < want;
  }
  return false;
}

/** Why this database cannot keep a standby copy as it is set up, or null when it can. */
export function standbySupport(db: {
  name: string;
  type: DatabaseType;
  version: string;
  customImage: string | null;
  customCommand: string | null;
}): string | null {
  const engine = STANDBY_ENGINES[db.type];
  if (!engine)
    return (
      NEVER[db.type] ??
      `A standby copy is available for ${supported()} databases only.`
    );
  if (db.customCommand?.trim())
    return `${db.name} starts with its own command, which a standby copy cannot follow. Remove the custom command first.`;
  const image = db.customImage?.trim();
  if (image && !isOfficialEngineImage(db.type, image))
    return `${db.name} runs an image of its own, which a standby copy cannot follow. Use the ${engine.label} image first.`;
  if (!image && olderThan(db.version, engine.minVersion))
    return `A standby copy needs ${engine.label} ${engine.minVersion} or newer. ${db.name} runs ${db.version}.`;
  return null;
}

export type StandbyRefusal =
  "one_member" | "few_members" | "no_room" | "no_member_online" | "too_old";

/** The fixed sentences a standby copy with nowhere to run becomes. */
export function standbyRefusal(
  reason: StandbyRefusal,
  a: {
    cluster: string;
    name: string;
    neededMb?: number;
    engine?: string;
    members?: number;
    minMembers?: number;
  },
): string {
  switch (reason) {
    case "few_members":
      return `Deplo keeps a standby copy of a ${a.engine} database only on a cluster of ${a.minMembers} servers or more. Cluster ${a.cluster} has ${a.members}: add a server to it.`;
    case "one_member":
      return `Cluster ${a.cluster} has one server, so a standby copy of ${a.name} has nowhere to run. Add a server to the cluster.`;
    case "no_room":
      return `No other server in cluster ${a.cluster} has ${a.neededMb ?? 0} MB free for a standby copy of ${a.name}. Add a server to it or lower ${a.name}'s memory.`;
    case "no_member_online":
      return `No other server in cluster ${a.cluster} is online and ready right now, so a standby copy of ${a.name} has nowhere to run. Bring a server back or add one.`;
    case "too_old":
      return `No other server in cluster ${a.cluster} can keep a standby copy yet: their server agents need an update, which Deplo does on its own.`;
  }
}

/** Why a cluster of `members` servers is too small for this engine's copy, or null when it is not. */
export function standbyMembersRefusal(
  engine: StandbyEngine,
  a: { cluster: string; name: string; members: number },
): string | null {
  const minMembers = engine.minMembers ?? 2;
  if (a.members >= minMembers) return null;
  return a.members < 2
    ? standbyRefusal("one_member", a)
    : standbyRefusal("few_members", {
        ...a,
        engine: engine.label,
        minMembers,
      });
}

/** What the switch costs, as it states it: memory on a second server, a second copy, what is kept here, a restart. */
export function standbyCost(db: {
  type: DatabaseType;
  resources: Pick<ResourceLimits, "memoryMb"> | null;
  sizeMb: number;
}): string {
  const memory = db.resources?.memoryMb
    ? `${db.resources.memoryMb} MB of memory`
    : "as much memory as the database";
  const size =
    db.sizeMb > 0 ? ` (${formatBytes(db.sizeMb * 1024 * 1024)})` : "";
  const engine = STANDBY_ENGINES[db.type];
  return (
    `Uses ${memory} on a second server and a second copy of its data${size}.` +
    (engine?.kept ? ` ${engine.kept}` : "") +
    (engine?.settings ? " Turning it on or off restarts the database." : "")
  );
}
