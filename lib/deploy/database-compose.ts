// https://deplo.build/docs/guides/data/databases

import { escapeComposeDollars } from "./compose-stack/compose-read";
import { deploLabels } from "./compose-stack/service-stamp";
import { renderResourceLimitsYaml } from "./resources";
import type { ResourceLimits } from "../types/container";
import type { DatabaseType } from "../types/database";
import { isOfficialEngineImage } from "../databases/images";

// Derived engine image per type+version.
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

// The in-container path each engine's image actually writes its data to.
export const DB_DATA_DIRS: Record<DatabaseType, string> = {
  postgres: "/var/lib/postgresql/data",
  mysql: "/var/lib/mysql",
  mariadb: "/var/lib/mysql",
  mongodb: "/data/db",
  redis: "/data",
  clickhouse: "/var/lib/clickhouse",
};

// The image a database runs: the expert override when set, else the derived engine image.
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

// The official mysql/mariadb images ALWAYS need a root password; `*_USER` is an optional extra user.
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

export function generateDatabaseCompose(input: {
  name: string;
  databaseId: string;
  type: DatabaseType;
  version: string;
  username: string;
  password: string;
  // MUST match the connection-string path segment and the backup dump target, or a
  // backup silently dumps a database that does not exist.
  dbName: string;
  hostPort?: number;
  resources?: ResourceLimits | null;
  customImage?: string | null;
  customCommand?: string | null;
  mounts?: { filePath: string; mountPath: string }[] | null;
  filesDir?: string | null;
  network: string;
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

  const customCommand = input.customCommand?.trim();
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
    ],
    redis: customCommand ? [] : [`REDISCLI_AUTH=${password}`],
    clickhouse: [
      `CLICKHOUSE_USER=${username}`,
      `CLICKHOUSE_PASSWORD=${password}`,
      `CLICKHOUSE_DB=${dbName}`,
    ],
  };
  const defaultCommand =
    type === "redis"
      ? `redis-server --requirepass ${escapeComposeDollars(password)}`
      : "";
  // A USER-supplied command is emitted double-quoted (JSON is valid YAML) so embedded
  // quotes or a `: ` can never change the YAML parse.
  const command = customCommand
    ? `    command: ${escapeComposeDollars(JSON.stringify(customCommand))}\n`
    : defaultCommand
      ? `    command: ${defaultCommand}\n`
      : "";
  const envLines = envByType[type];
  const envBlock = envLines.length
    ? "    environment:\n" +
      envLines.map((l) => `      - ${escapeComposeDollars(l)}`).join("\n") +
      "\n"
    : "";
  const ports = hostPort
    ? `    ports:\n      - "0.0.0.0:${hostPort}:${port}"\n`
    : "";
  const labels = deploLabels(databaseId, name)
    .map((l) => `      - ${l}`)
    .join("\n");
  const resources = renderResourceLimitsYaml(input.resources, 4);
  const configMounts = (input.mounts ?? [])
    .map((m) => {
      const source = `${(input.filesDir ?? "").replace(/\/+$/, "")}/${m.filePath}`;
      return `\n      - ${JSON.stringify(`${source}:${m.mountPath}`)}`;
    })
    .join("");

  const custom = input.customImage?.trim();
  const healthTest =
    custom && !isOfficialEngineImage(type, custom)
      ? "exit 0"
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

// Build the (unencrypted) connection string for a managed database.
export function buildConnectionString(a: {
  type: DatabaseType;
  username: string;
  password: string;
  host: string;
  port: number;
  dbName: string;
}): string {
  const { type, username, password, host, port, dbName } = a;
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  switch (type) {
    case "redis":
      return `redis://${auth}`;
    case "mongodb":
      // The root user is always created in the `admin` database, hence ?authSource=admin.
      return `mongodb://${auth}/${dbName}?authSource=admin`;
    case "mariadb":
      // The mariadb wire protocol is mysql's, so clients use the mysql:// scheme.
      return `mysql://${auth}/${dbName}`;
    case "postgres":
    case "mysql":
    case "clickhouse":
      return `${type}://${auth}/${dbName}`;
  }
}

// Recover the engine password embedded in a connection string.
export function parseConnectionPassword(conn: string): string {
  try {
    return decodeURIComponent(new URL(conn).password);
  } catch {
    return "";
  }
}
