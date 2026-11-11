import { escapeComposeDollars } from "./compose-stack/compose-read";
import { deploLabels } from "./compose-stack/service-stamp";
import { renderYamlKeys } from "./health-check";
import { defaultLogging, renderResourceLimitsYaml } from "./resources";
import type { ResourceLimits } from "../types/container";
import type { DatabaseType } from "../types/database";
import type { DatabaseReach } from "../databases/link";
import {
  CHANGE_LOG_DIR,
  CHANGE_LOG_KEPT_MINUTES,
} from "../databases/change-log";
import { isOfficialEngineImage } from "../databases/images";
import { formatHostPort } from "../host-address";
import { deploImageClaim, deploImageMessage } from "./deplo-image";

export const DB_IMAGES: Record<DatabaseType, (v: string) => string> = {
  postgres: (v) => `postgres:${v}-alpine`,
  mysql: (v) => `mysql:${v}`,
  mariadb: (v) => `mariadb:${v}`,
  mongodb: (v) => `mongo:${v}`,
  redis: (v) => `redis:${v}-alpine`,
  clickhouse: (v) => `clickhouse/clickhouse-server:${v}`,
};

const DB_PORTS: Record<DatabaseType, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  redis: 6379,
  clickhouse: 8123,
};

export const DB_DATA_DIRS: Record<DatabaseType, string> = {
  postgres: "/var/lib/postgresql/data",
  mysql: "/var/lib/mysql",
  mariadb: "/var/lib/mysql",
  mongodb: "/data/db",
  redis: "/data",
  clickhouse: "/var/lib/clickhouse",
};

export function effectiveDatabaseImage(d: {
  type: DatabaseType;
  version: string;
  customImage: string | null;
}): string {
  return d.customImage?.trim() || DB_IMAGES[d.type](d.version);
}

const DB_HEALTHCHECKS: Record<
  DatabaseType,
  (a: { username: string; dbName: string }) => string
> = {
  postgres: ({ username, dbName }) => `pg_isready -U ${username} -d ${dbName}`,
  mysql: () => 'mysqladmin ping -h 127.0.0.1 -uroot -p"$$MYSQL_ROOT_PASSWORD"',
  mariadb: () => "healthcheck.sh --connect --innodb_initialized",
  mongodb: () => "mongosh --quiet --eval \"db.adminCommand('ping').ok\"",
  redis: () => "redis-cli ping",
  clickhouse: () =>
    "wget --no-verbose --tries=1 --spider http://127.0.0.1:8123/ping",
};

// The keyfile arrives as an env var and is written where mongod will accept it (its own, 0400).
const MONGO_REPLICA_START =
  'printf %s "$$MONGO_KEYFILE" > /etc/mongo-keyfile && ' +
  "chown mongodb:mongodb /etc/mongo-keyfile && chmod 400 /etc/mongo-keyfile && " +
  "exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /etc/mongo-keyfile --bind_ip_all";

// Healthy once the set exists; the first check creates it, which also converts a standalone's data in place.
function mongoReplicaHealthcheck(host: string): string {
  const init = `rs.initiate({_id:"rs0",members:[{_id:0,host:"${host}:27017"}]}).ok`;
  return (
    'mongosh --quiet -u "$$MONGO_INITDB_ROOT_USERNAME" -p "$$MONGO_INITDB_ROOT_PASSWORD" ' +
    `--authenticationDatabase admin --eval 'try{rs.status().ok}catch(e){${init}}'`
  );
}

function mysqlEnv(
  prefix: "MYSQL" | "MARIADB",
  username: string,
  password: string,
  dbName: string,
): string[] {
  const base = [
    `${prefix}_ROOT_PASSWORD=${password}`,
    `${prefix}_DATABASE=${dbName}`,
  ];
  return username === "root"
    ? base
    : [...base, `${prefix}_USER=${username}`, `${prefix}_PASSWORD=${password}`];
}

// Append-only, fsync every second. A dataset that only has a snapshot is switched on live: at
// startup Redis would load an empty append-only file and ignore the snapshot.
const REDIS_START = `d=/data
if [ -f $d/dump.rdb ] && [ ! -s $d/appendonly.aof ] && ! ls $d/appendonlydir/*.base.* >/dev/null 2>&1; then
  docker-entrypoint.sh redis-server --requirepass "$REDISCLI_AUTH" --appendonly no &
  pid=$!
  trap 'kill -TERM $pid' TERM INT
  until redis-cli ping >/dev/null 2>&1; do sleep 0.2; done
  redis-cli config set appendfsync everysec >/dev/null
  redis-cli config set appendonly yes >/dev/null
  wait $pid
  wait $pid
else
  exec docker-entrypoint.sh redis-server --requirepass "$REDISCLI_AUTH" --appendonly yes --appendfsync everysec
fi
`;

// A finished piece of the change log is copied beside the data, at most a minute after its first write; the
// server agent ships it from there. https://deplo.build/docs/operations/clusters#databases
const WAL_DIR = `${DB_DATA_DIRS.postgres}/${CHANGE_LOG_DIR}`;
const POSTGRES_ARCHIVE = [
  "archive_mode=on",
  // What nothing collected in time is dropped, so a destination that is away never fills the database's disk.
  `archive_command=mkdir -p ${WAL_DIR} && { find ${WAL_DIR} -type f -mmin +${CHANGE_LOG_KEPT_MINUTES} -delete; cp %p ${WAL_DIR}/.%f; } && mv ${WAL_DIR}/.%f ${WAL_DIR}/%f`,
  "archive_timeout=60",
];

export function generateDatabaseCompose(input: {
  name: string;
  databaseId: string;
  type: DatabaseType;
  version: string;
  username: string;
  password: string;
  dbName: string;
  hostPort?: number;
  resources?: ResourceLimits | null;
  customImage?: string | null;
  customCommand?: string | null;
  mounts?: { filePath: string; mountPath: string }[] | null;
  filesDir?: string | null;
  network: string;
  // MongoDB runs as a one-member replica set when it has one: the dump then carries its oplog.
  mongoKeyfile?: string | null;
  // Postgres on a cluster: see archivesChangeLog.
  archiveChangeLog?: boolean;
}): string {
  const {
    name,
    databaseId,
    type,
    version,
    username,
    password,
    dbName,
    hostPort,
  } = input;
  const port = DB_PORTS[type];
  const image = effectiveDatabaseImage({
    type,
    version,
    customImage: input.customImage ?? null,
  });
  const claim = input.customImage?.trim() ? deploImageClaim(image) : null;
  if (claim) throw new Error(deploImageMessage(image, claim, "This database"));

  const customCommand = input.customCommand?.trim();
  const custom = input.customImage?.trim();
  const replicaSet =
    type === "mongodb" &&
    !!input.mongoKeyfile &&
    !customCommand &&
    !(custom && !isOfficialEngineImage(type, custom));
  const envByType: Record<DatabaseType, string[]> = {
    postgres: [
      `POSTGRES_USER=${username}`,
      `POSTGRES_PASSWORD=${password}`,
      `POSTGRES_DB=${dbName}`,
      `PGDATA=${DB_DATA_DIRS.postgres}`,
    ],
    mysql: mysqlEnv("MYSQL", username, password, dbName),
    mariadb: mysqlEnv("MARIADB", username, password, dbName),
    mongodb: [
      `MONGO_INITDB_ROOT_USERNAME=${username}`,
      `MONGO_INITDB_ROOT_PASSWORD=${password}`,
      ...(replicaSet ? [`MONGO_KEYFILE=${input.mongoKeyfile}`] : []),
    ],
    redis: customCommand ? [] : [`REDISCLI_AUTH=${password}`],
    clickhouse: [
      `CLICKHOUSE_USER=${username}`,
      `CLICKHOUSE_PASSWORD=${password}`,
      `CLICKHOUSE_DB=${dbName}`,
    ],
  };
  // Postgres settings the platform owns, each one a `-c`; empty leaves the image's own command.
  const postgresSettings: string[] = [];
  if (type === "postgres" && input.archiveChangeLog)
    postgresSettings.push(...POSTGRES_ARCHIVE);
  const command = customCommand
    ? `    command: ${escapeComposeDollars(JSON.stringify(customCommand))}\n`
    : postgresSettings.length > 0
      ? `    command: ${JSON.stringify(["postgres", ...postgresSettings.flatMap((s) => ["-c", s])])}\n`
      : replicaSet
        ? `    command: ${JSON.stringify(["sh", "-c", MONGO_REPLICA_START])}\n`
        : type === "redis"
          ? `    command: ${escapeComposeDollars(JSON.stringify(["sh", "-c", REDIS_START]))}\n`
          : "";
  const envLines = envByType[type];
  const envBlock = envLines.length
    ? "    environment:\n" +
      envLines.map((l) => `      - ${escapeComposeDollars(l)}`).join("\n") +
      "\n"
    : "";
  const ports = hostPort ? `    ports:\n      - "${hostPort}:${port}"\n` : "";
  const labels = deploLabels(databaseId, name)
    .map((l) => `      - ${l}`)
    .join("\n");
  const resources =
    renderResourceLimitsYaml(input.resources, 4) +
    renderYamlKeys({ logging: defaultLogging() }, 4);
  const configMounts = (input.mounts ?? [])
    .map((m) => {
      const source = `${(input.filesDir ?? "").replace(/\/+$/, "")}/${m.filePath}`;
      return `\n      - ${escapeComposeDollars(JSON.stringify(`${source}:${m.mountPath}`))}`;
    })
    .join("");

  const healthTest =
    custom && !isOfficialEngineImage(type, custom)
      ? "exit 0"
      : replicaSet
        ? mongoReplicaHealthcheck(name)
        : DB_HEALTHCHECKS[type]({ username, dbName });

  return `# Generated by Deplo  database ${name} (${type})
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    labels:
${labels}
    networks:
      - deplo
${resources}${command}${envBlock}${ports}    volumes:
      - ${name}-data:${DB_DATA_DIRS[type]}${configMounts}
    healthcheck:
      test: ["CMD-SHELL", ${JSON.stringify(healthTest)}]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s

volumes:
  ${name}-data:

networks:
  deplo:
    name: ${input.network}
    external: true
`;
}

export function buildConnectionString(a: {
  type: DatabaseType;
  username: string;
  password: string;
  host: string;
  port: number;
  dbName: string;
}): string {
  const { type, username, password, host, port, dbName } = a;
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@${formatHostPort(host, port)}`;
  switch (type) {
    case "redis":
      return `redis://${auth}`;
    case "mongodb":
      return `mongodb://${auth}/${dbName}?authSource=admin&directConnection=true`;
    case "mariadb":
      return `mysql://${auth}/${dbName}`;
    case "postgres":
    case "mysql":
    case "clickhouse":
      return `${type}://${auth}/${dbName}`;
  }
}

export function parseConnectionPassword(conn: string): string {
  try {
    return decodeURIComponent(new URL(conn).password);
  } catch {
    return "";
  }
}

// Spellings an app's driver may insist on: SQLAlchemy refuses postgres://, asyncpg wants postgresql+asyncpg://.
const SCHEME_ALIASES: Record<string, string[]> = {
  postgres: ["postgresql"],
  mysql: ["mariadb"],
};
// A +driver suffix, never +srv: that one changes how the host is looked up.
const SCHEME = /^([a-z][a-z0-9.-]*)(?:\+(?!srv:)[a-z0-9_.-]+)?:\/\//i;

// `conn` spelled with the scheme `written` uses, when both name the same kind of database.
export function inSchemeOf(written: string, conn: string): string {
  const w = SCHEME.exec(written.trimStart());
  const c = SCHEME.exec(conn);
  if (!w || !c) return conn;
  const base = w[1]!.toLowerCase();
  const own = c[1]!.toLowerCase();
  if (base !== own && !SCHEME_ALIASES[own]?.includes(base)) return conn;
  return w[0] + conn.slice(c[0].length);
}

// The stored string is the public one while the database is exposed, the private one otherwise.
export function linkedConnectionString(
  db: {
    type: DatabaseType;
    username: string;
    dbName: string;
    host: string;
    port: number;
  },
  storedConnection: string,
  reach: DatabaseReach,
  written = "",
): string {
  if (reach === "public") return inSchemeOf(written, storedConnection);
  return inSchemeOf(
    written,
    buildConnectionString({
      type: db.type,
      username: db.username,
      password: parseConnectionPassword(storedConnection),
      host: db.host,
      port: db.port,
      dbName: db.dbName,
    }),
  );
}

// What Deplo shows for a database, so what a person copies: the private string and the stored one.
export function exactConnectionStrings(
  db: Parameters<typeof linkedConnectionString>[0],
  storedConnection: string,
): string[] {
  return [
    ...new Set([
      linkedConnectionString(db, storedConnection, "internal"),
      storedConnection,
    ]),
  ];
}
