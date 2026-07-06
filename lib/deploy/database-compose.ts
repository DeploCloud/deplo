/**
 * docker-compose generation for databases.
 * Deplo turns a database request into a compose service wired to the shared
 * `deplo` Docker network. Databases are NOT publicly routed (no Traefik labels);
 * apps are rendered by the deploy engine (`build.ts` renderCompose), not here.
 */
import type { DatabaseType } from "../types";

const DB_IMAGES: Record<DatabaseType, (v: string) => string> = {
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

/**
 * The in-container path each engine's image actually writes its data to. The
 * named data volume MUST mount here or the data is not persisted (it lives in
 * the container's ephemeral layer and is lost on recreation) — and a backup
 * restore that writes to the engine's real data dir would land outside the
 * volume. These are the official images' documented data dirs:
 *  - postgres  /var/lib/postgresql/data
 *  - mysql     /var/lib/mysql
 *  - mariadb   /var/lib/mysql   (mariadb image reuses the mysql layout)
 *  - mongodb   /data/db
 *  - redis     /data
 *  - clickhouse /var/lib/clickhouse
 */
const DB_DATA_DIRS: Record<DatabaseType, string> = {
  postgres: "/var/lib/postgresql/data",
  mysql: "/var/lib/mysql",
  mariadb: "/var/lib/mysql",
  mongodb: "/data/db",
  redis: "/data",
  clickhouse: "/var/lib/clickhouse",
};

/**
 * mysql/mariadb env. The official images ALWAYS need a root password
 * (`*_ROOT_PASSWORD`) and treat `*_USER`/`*_PASSWORD` as an OPTIONAL additional
 * non-root user granted all privileges on `*_DATABASE` only. They REJECT
 * `*_USER=root`. So we emit the extra user only when a non-root username was
 * chosen; otherwise `root` IS the login and its password is the connection-string
 * password. Either way root's password == the connection-string password, which
 * is load-bearing: the backup dump execs as root (a scoped MYSQL_USER lacks the
 * global grants `mysqldump --databases` needs) and reads that same password from
 * the connection string. See `lib/data/backups.ts` `dumpUserFor`.
 */
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
  /** The service / container / volume name (the agent stack slug, `db-<name>`). */
  name: string;
  type: DatabaseType;
  version: string;
  /**
   * The engine login to create on first init (`POSTGRES_USER`, `MYSQL_USER`,
   * `MONGO_INITDB_ROOT_USERNAME`, `CLICKHOUSE_USER`). Inert for redis (no user
   * concept). Applied ONLY on first boot against an empty volume.
   */
  username: string;
  password: string;
  /**
   * The logical database to create on first init (`POSTGRES_DB`, `MYSQL_DATABASE`,
   * `CLICKHOUSE_DB`). This MUST match the connection-string path segment and the
   * backup dump target or a backup silently dumps a non-existent database. Inert
   * for redis and mongodb (mongo creates DBs lazily on first write).
   */
  dbName: string;
  /**
   * The HOST port to publish the engine on. When set, the compose maps
   * `hostPort:<engine-port>` so external clients reach the DB on the host's
   * `hostPort` (which the control plane validated is free on that host). Omitted
   * => the DB is NOT publicly published (internal `deplo`-network access only).
   */
  hostPort?: number;
}): string {
  const { name, type, version, username, password, dbName, hostPort } = input;
  const port = DB_PORTS[type];
  const image = DB_IMAGES[type](version);

  const envByType: Record<DatabaseType, string[]> = {
    postgres: [
      `POSTGRES_USER=${username}`,
      `POSTGRES_PASSWORD=${password}`,
      `POSTGRES_DB=${dbName}`,
    ],
    mysql: mysqlEnv("MYSQL", username, password, dbName),
    mariadb: mysqlEnv("MARIADB", username, password, dbName),
    mongodb: [
      `MONGO_INITDB_ROOT_USERNAME=${username}`,
      `MONGO_INITDB_ROOT_PASSWORD=${password}`,
    ],
    redis: [],
    // CLICKHOUSE_DB creates the logical database at provision time, like
    // POSTGRES_DB / MYSQL_DATABASE above. Without it the image only has the
    // built-in `default` DB, so the connection string's database — and every
    // backup that dumps it — would target a database that never exists (a silent
    // empty backup + no-op restore).
    clickhouse: [
      `CLICKHOUSE_USER=${username}`,
      `CLICKHOUSE_PASSWORD=${password}`,
      `CLICKHOUSE_DB=${dbName}`,
    ],
  };
  const command =
    type === "redis"
      ? `    command: redis-server --requirepass ${password}\n`
      : "";
  const envLines = envByType[type];
  const envBlock = envLines.length
    ? "    environment:\n" +
      envLines.map((l) => `      - ${l}`).join("\n") +
      "\n"
    : "";
  // Publish the engine port on the chosen HOST port when exposed. Bind to 0.0.0.0
  // explicitly so the mapping is reachable off-host regardless of the daemon's
  // default publish address (some hosts default published ports to 127.0.0.1,
  // which would make "expose publicly" only reachable from the host itself).
  const ports = hostPort
    ? `    ports:\n      - "0.0.0.0:${hostPort}:${port}"\n`
    : "";

  return `# Generated by Deplo  database ${name} (${type})
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    networks:
      - deplo
${command}${envBlock}${ports}    volumes:
      - ${name}-data:${DB_DATA_DIRS[type]}
    healthcheck:
      test: ["CMD-SHELL", "exit 0"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  ${name}-data:

networks:
  deplo:
    external: true
`;
}

/**
 * Build the (unencrypted) connection string for a managed database. The single
 * source of truth for the string's shape, shared by `createDatabase` (initial
 * provision) and `updateDatabase` (re-derived when exposure toggles the host/port).
 * Keeping it here — not duplicated at each call site — stops the two paths from
 * drifting on scheme, path segment, or the mongo authSource.
 *
 * `host`/`port` are already reachability-resolved by the caller: the internal
 * service DNS name + engine port when unexposed, the server's reachable host +
 * published host port when exposed. `username`/`password`/`dbName` ride raw
 * (createDatabase sanitizes the identifiers and rejects URL-unsafe passwords, and
 * randomToken is URL-safe), so no percent-encoding is applied here.
 */
export function buildConnectionString(a: {
  type: DatabaseType;
  username: string;
  password: string;
  host: string;
  port: number;
  /** The logical DB / path segment. Ignored for redis (no logical DB). */
  dbName: string;
}): string {
  const { type, username, password, host, port, dbName } = a;
  const auth = `${username}:${password}@${host}:${port}`;
  switch (type) {
    case "redis":
      // Redis has no logical DB — no path segment (a numeric SELECT db, not a
      // named one, and Deplo doesn't set it). The user is `default`.
      return `redis://${auth}`;
    case "mongodb":
      // The root user (MONGO_INITDB_ROOT_USERNAME) is always created in the
      // `admin` database, so the client MUST authenticate there regardless of the
      // default DB in the path — hence ?authSource=admin.
      return `mongodb://${auth}/${dbName}?authSource=admin`;
    case "mariadb":
      // The mariadb wire protocol is mysql's; clients/drivers use the mysql://
      // scheme. Keep the historical scheme rewrite.
      return `mysql://${auth}/${dbName}`;
    case "postgres":
    case "mysql":
    case "clickhouse":
      return `${type}://${auth}/${dbName}`;
  }
}

/**
 * Recover the engine password embedded in a connection string. Every form
 * {@link buildConnectionString} emits carries it as the URL password
 * (`scheme://user:<pw>@host`), so a URL parse is the single source. Returns ""
 * when absent or unparseable rather than throwing. Shared with the backups module
 * (the dump password) and `updateDatabase` (which re-derives the string around the
 * unchanged, create-only password).
 */
export function parseConnectionPassword(conn: string): string {
  try {
    return decodeURIComponent(new URL(conn).password);
  } catch {
    return "";
  }
}
