/**
 * docker-compose generation for databases.
 */
import { deploLabels } from "./compose-stack";
import { renderResourceLimitsYaml } from "./resources";
import type { DatabaseType, ResourceLimits } from "../types";

/**
 * Derived engine image per type+version.
 */
export const DB_IMAGES: Record<DatabaseType, (v: string) => string> = {
  postgres: (v) => `postgres:${v}-alpine`,
  mysql: (v) => `mysql:${v}`,
  mariadb: (v) => `mariadb:${v}`,
  mongodb: (v) => `mongo:${v}`,
  redis: (v) => `redis:${v}-alpine`,
  clickhouse: (v) => `clickhouse/clickhouse-server:${v}`,
};

/**
 * The repository each engine's OFFICIAL image lives at — the same repos
 * {@link DB_IMAGES} derives from, split out so a `customImage` can be recognised
 * as "still the official image, just pinned differently".
 */
const DB_REPOS: Record<DatabaseType, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongo",
  redis: "redis",
  clickhouse: "clickhouse/clickhouse-server",
};

/**
 * Is `image` the engine's official image at some tag or digest? A pinned
 * `postgres:18` still ships `pg_isready`, so it must keep a real probe.
 */
export function isOfficialEngineImage(
  type: DatabaseType,
  image: string | null | undefined,
): boolean {
  const s = image?.trim();
  if (!s) return false;
  const ref = s.split("@")[0];
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  const repo = colon > slash ? ref.slice(0, colon) : ref;
  const want = DB_REPOS[type];
  return (
    repo === want || repo === `library/${want}` || repo === `docker.io/${want}`
  );
}

const DB_PORTS: Record<DatabaseType, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  redis: 6379,
  clickhouse: 8123,
};

/**
 * The in-container path each engine's image actually writes its data to.
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
 * the runtime "healthy/unhealthy" the agent reports reflects the ENGINE, not just
 * the process.
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
 * non-root user granted all privileges on `*_DATABASE` only.
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
   * backup dump target or a backup silently dumps a non-existent database.
   */
  dbName: string;
  /**
   * The HOST port to publish the engine on.
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
  /**
   * Expert override: the engine's own config files, already written to `filesDir`
   * by the agent.
   */
  mounts?: { filePath: string; mountPath: string }[] | null;
  /**
   * The absolute host directory those files land in ({@link stackFilesDir} of
   * this stack's slug). Required only when `mounts` is non-empty; the caller
   * owns it because the path is the agent's contract, not this renderer's.
   */
  filesDir?: string | null;
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

  const envByType: Record<DatabaseType, string[]> = {
    // PGDATA is REQUIRED, not cosmetic.
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
    redis: [],
    // CLICKHOUSE_DB creates the logical database at provision time, like POSTGRES_DB /
    // MYSQL_DATABASE above.
    clickhouse: [
      `CLICKHOUSE_USER=${username}`,
      `CLICKHOUSE_PASSWORD=${password}`,
      `CLICKHOUSE_DB=${dbName}`,
    ],
  };
  const customCommand = input.customCommand?.trim();
  const defaultCommand =
    type === "redis" ? `redis-server --requirepass ${password}` : "";
  // The default (redis) command renders as the historical plain scalar; a
  // USER-supplied command is emitted double-quoted (JSON is valid YAML) so
  // embedded quotes / a `: ` can never change the YAML parse.
  const command = customCommand
    ? `    command: ${JSON.stringify(customCommand)}\n`
    : defaultCommand
      ? `    command: ${defaultCommand}\n`
      : "";
  const envLines = envByType[type];
  const envBlock = envLines.length
    ? "    environment:\n" +
      envLines.map((l) => `      - ${l}`).join("\n") +
      "\n"
    : "";
  // Publish the engine port on the chosen HOST port when exposed.
  const ports = hostPort
    ? `    ports:\n      - "0.0.0.0:${hostPort}:${port}"\n`
    : "";
  const labels = deploLabels(databaseId, name)
    .map((l) => `      - ${l}`)
    .join("\n");
  // Same fragment renderer as the single-image app path — empty limits render
  // nothing, so a database that never set a limit keeps its historical bytes.
  const resources = renderResourceLimitsYaml(input.resources, 4);
  // The engine probe assumes the engine's official image; under a FOREIGN customImage
  // the tooling may not exist, so fall back to the historical no-op rather than
  // flagging a healthy container "unhealthy" forever.
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
    external: true
`;
}

/**
 * Build the (unencrypted) connection string for a managed database.
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
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
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
 * Recover the engine password embedded in a connection string.
 */
export function parseConnectionPassword(conn: string): string {
  try {
    return decodeURIComponent(new URL(conn).password);
  } catch {
    return "";
  }
}
