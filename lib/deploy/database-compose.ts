/**
 * docker-compose generation for databases.
 * Deplo turns a database request into a compose service wired to the shared
 * `deplo` Docker network. Databases are NOT publicly routed (no Traefik labels);
 * apps are rendered by the deploy engine (`build.ts` renderCompose), not here.
 */
import { deploLabels } from "./compose-stack";
import { renderResourceLimitsYaml } from "./resources";
import type { DatabaseType, ResourceLimits } from "../types";

/**
 * Derived engine image per type+version. Exported so display surfaces (console
 * info, the image-settings form) can show the effective image when no
 * `customImage` override is set — always via `effectiveDatabaseImage`, never by
 * re-deriving inline.
 */
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
export const DB_DATA_DIRS: Record<DatabaseType, string> = {
  postgres: "/var/lib/postgresql/data",
  mysql: "/var/lib/mysql",
  mariadb: "/var/lib/mysql",
  mongodb: "/data/db",
  redis: "/data",
  clickhouse: "/var/lib/clickhouse",
};

/** The image a database actually runs: the expert override when set, else the
 * derived engine image. The ONE precedence rule, shared by the renderer and
 * every display surface. */
export function effectiveDatabaseImage(d: {
  type: DatabaseType;
  version: string;
  customImage: string | null;
}): string {
  return d.customImage?.trim() || DB_IMAGES[d.type](d.version);
}

/**
 * Real per-engine liveness probes (replacing the historical no-op `exit 0`), so
 * the runtime "healthy/unhealthy" the agent reports reflects the ENGINE, not
 * just the process. Each is chosen to avoid embedding the password literally:
 *  - postgres    pg_isready authenticates nothing — it only asks "accepting
 *                connections?" (identifiers are sanitized, safe to embed).
 *  - mysql       mysqladmin ping as root; the password rides as the container's
 *                own $MYSQL_ROOT_PASSWORD env ($$ = compose-interpolation escape).
 *  - mariadb     the official image's healthcheck.sh (the entrypoint creates a
 *                dedicated healthcheck user + config on first init). A volume
 *                initialized by a pre-2022 image lacks that user — the container
 *                then shows "unhealthy" but keeps running (restart is unchanged).
 *  - mongodb     `ping` is one of the commands mongod allows unauthenticated.
 *  - redis       redis-cli exits 0 whenever the server RESPONDS (even NOAUTH),
 *                non-zero when unreachable — a liveness probe that keeps working
 *                whatever a custom command does to `--requirepass`.
 *  - clickhouse  the unauthenticated HTTP /ping endpoint (image ships wget).
 */
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
  /**
   * The database row id (`db_…`), stamped as `deplo.project` on the container.
   * Load-bearing: the agent label-checks `deplo.project=<id>` on every container
   * RPC (listInstances / exec / attach / followLogs), so without these labels
   * the DB container is invisible to logs, the terminal, and the runtime poll.
   * A pre-labels container becomes visible on its next reroute ("Redeploy").
   */
  databaseId: string;
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
  /** Per-database resource limits; null/absent ⇒ no limit keys are rendered. */
  resources?: ResourceLimits | null;
  /** Expert image override; replaces the derived engine image when set. */
  customImage?: string | null;
  /**
   * Expert command override; REPLACES the default command verbatim. For redis
   * the default carries `--requirepass <password>` — omitting it from a custom
   * command drops auth (the UI warns; not blocked, it's the escape hatch).
   */
  customCommand?: string | null;
}): string {
  const { name, databaseId, type, version, username, password, dbName, hostPort } =
    input;
  const port = DB_PORTS[type];
  const image = effectiveDatabaseImage({
    type,
    version,
    customImage: input.customImage ?? null,
  });

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
  const customCommand = input.customCommand?.trim();
  const defaultCommand =
    type === "redis" ? `redis-server --requirepass ${password}` : "";
  const commandLine = customCommand || defaultCommand;
  const command = commandLine ? `    command: ${commandLine}\n` : "";
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
  const labels = deploLabels(databaseId, name)
    .map((l) => `      - ${l}`)
    .join("\n");
  // Same fragment renderer as the single-image app path — empty limits render
  // nothing, so a database that never set a limit keeps its historical bytes.
  const resources = renderResourceLimitsYaml(input.resources, 4);
  // The engine probe assumes the engine's official image; under a customImage
  // override the tooling may not exist, so fall back to the historical no-op
  // rather than flagging a healthy container "unhealthy" forever.
  const healthTest = input.customImage?.trim()
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
      - ${name}-data:${DB_DATA_DIRS[type]}
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
