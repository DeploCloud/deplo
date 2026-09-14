import { parseEnvBlob } from "../../map/env";
import type { SourceDatabase, SourceDbKind } from "../../model";
import type { CoolifyDatabase } from "../client";
import type { CoolifyExtras } from "./extras";

/** Coolify's engine name -> Deplo's spelling. `standalone-` is the list endpoints' prefix. */
const DB_KIND: Record<string, SourceDbKind> = {
  postgresql: "postgres",
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongo",
  mongo: "mongo",
  redis: "redis",
  clickhouse: "clickhouse",
  keydb: "keydb",
  dragonfly: "dragonfly",
};

/**
 * The engine of one database ROW. `database_type` is what the API answers with -
 * reading `type` alone found nothing and dropped every database in silence.
 */
export function coolifyDbKindOf(
  row: Pick<CoolifyDatabase, "database_type" | "type" | "image">,
): SourceDbKind | null {
  return (
    coolifyDbKind(row.database_type ?? row.type) ?? kindFromImage(row.image)
  );
}

/** KeyDB's table carries no `database_type` at all, so the engine comes from the
 *  one other column that names it: the image the panel runs. */
function kindFromImage(image: string | null | undefined): SourceDbKind | null {
  const ref = (image ?? "").toLowerCase();
  if (!ref) return null;
  for (const [word, kind] of Object.entries(DB_KIND))
    if (new RegExp(`(^|[/:_-])${word}([/:_.-]|$)`).test(ref)) return kind;
  return null;
}

export function coolifyDbKind(
  type: string | null | undefined,
): SourceDbKind | null {
  const t = (type ?? "")
    .trim()
    .toLowerCase()
    .replace(/^standalone-/, "");
  return DB_KIND[t] ?? null;
}

/** Where each engine keeps its credentials. Read by name, never guessed. */
const DB_FIELDS: Record<
  SourceDbKind,
  { user?: string[]; password?: string[]; database?: string[]; root?: string[] }
> = {
  postgres: {
    user: ["postgres_user"],
    password: ["postgres_password"],
    database: ["postgres_db"],
  },
  mysql: {
    user: ["mysql_user"],
    password: ["mysql_password"],
    database: ["mysql_database"],
    root: ["mysql_root_password"],
  },
  mariadb: {
    user: ["mariadb_user"],
    password: ["mariadb_password"],
    database: ["mariadb_database"],
    root: ["mariadb_root_password"],
  },
  mongo: {
    user: ["mongo_initdb_root_username"],
    password: ["mongo_initdb_root_password"],
    database: ["mongo_initdb_database"],
  },
  redis: { user: ["redis_username"], password: ["redis_password"] },
  clickhouse: {
    user: ["clickhouse_admin_user"],
    password: ["clickhouse_admin_password"],
  },
  keydb: { password: ["keydb_password"] },
  dragonfly: { password: ["dragonfly_password"] },
  libsql: {},
  unknown: {},
};

/**
 * Whether this row still CARRIES its engine's password column. Coolify drops the
 * key entirely for a token that may not read it, so the presence of the key, not
 * its value, is what says the token holds `read:sensitive`.
 */
export function coolifyDbSecretsVisible(
  row: CoolifyDatabase,
  kind: SourceDbKind,
): boolean {
  const f = DB_FIELDS[kind];
  return [...(f.password ?? []), ...(f.root ?? [])].some((k) => k in row);
}

function pick(row: CoolifyDatabase, keys: string[] | undefined): string | null {
  for (const k of keys ?? []) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * The same credential, out of the resource's own variables. Redis keeps its
 * password ONLY there, and minting a new one silently broke every app that talked
 * to it. The column names are the variable names, so one list serves both.
 */
function pickEnv(
  blob: string | null | undefined,
  keys: string[] | undefined,
): string | null {
  if (!blob || !keys?.length) return null;
  const wanted = new Set(keys.map((k) => k.toUpperCase()));
  for (const e of parseEnvBlob(blob))
    if (wanted.has(e.key.toUpperCase()) && e.value.trim()) return e.value;
  return null;
}

export function coolifyDatabase(
  row: CoolifyDatabase,
  kind: SourceDbKind,
  extras: CoolifyExtras = {},
): SourceDatabase {
  const f = DB_FIELDS[kind];
  // A custom engine configuration lives in a `<engine>_conf` column here and in
  // a config file under Settings > Advanced on Deplo; it does not travel yet.
  const conf = (row as Record<string, unknown>)[`${kind}_conf`];
  const confNote =
    typeof conf === "string" && conf.trim()
      ? [
          `Ran with a custom ${kind} configuration on {panel} that did not come across. Add it under Settings > Advanced once the database is here.`,
        ]
      : [];
  return {
    [`${kind}Id`]: row.uuid,
    platformNotes: [...(extras.envNotes ?? []), ...confNote],
    name: row.name ?? null,
    appName: row.name ?? null,
    description: row.description ?? null,
    dockerImage: row.image ?? null,
    databaseName: pick(row, f.database) ?? pickEnv(extras.env, f.database),
    databaseUser: pick(row, f.user) ?? pickEnv(extras.env, f.user),
    databasePassword: pick(row, f.password) ?? pickEnv(extras.env, f.password),
    databaseRootPassword: pick(row, f.root) ?? pickEnv(extras.env, f.root),
    env: extras.env ?? null,
    externalPort: row.is_public ? (row.public_port ?? null) : null,
    memoryLimit: row.limits_memory ?? null,
    memoryReservation: row.limits_memory_reservation ?? null,
    cpuLimit: row.limits_cpus ?? null,
    serverId: extras.serverId ?? "",
    environmentId: extras.environmentId ?? null,
    mounts: extras.mounts ?? [],
    backups: extras.backups ?? null,
  };
}
