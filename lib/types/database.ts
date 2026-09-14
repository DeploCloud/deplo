import type { ID } from "./identity";
import type { ResourceLimits } from "./container";

export type DatabaseType =
  "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" | "clickhouse";

export type DatabaseStatus = "running" | "stopped" | "provisioning" | "error";

export interface Database {
  id: ID;
  teamId: ID;
  // Placement, exactly like an {@link App}'s: the Environment this database lives
  // in, which is also the network it answers on. Null ⇒ the team's own network.
  environmentId: ID | null;
  // DISPLAY name, editable in Settings → General.
  name: string;
  // Uploaded logo (base64 data-URI), or null to fall back to the engine's brand
  // mark (`DB_LOGOS`). Cosmetic only, never read by a deploy.
  logo: string | null;
  type: DatabaseType;
  version: string;
  // The engine login the connection string authenticates as, and the user the
  // backup dump execs as (mysql/mariadb always dump as `root` - `dumpUserFor`).
  username: string;
  // The logical database created on first init (`POSTGRES_DB` / `MYSQL_DATABASE`
  // / `CLICKHOUSE_DB` / the mongo default DB).
  dbName: string;
  status: DatabaseStatus;
  // Why this database's data did not arrive, when a migration tried to copy it
  // and could not.
  dataCopyError: string;
  // The migration still creating this database. See {@link App.migrationRunId}.
  migrationRunId: ID | null;
  serverId: ID;
  host: string;
  port: number;
  // encrypted at rest
  connectionStringEnc: string;
  exposedPublicly: boolean;
  // The host port the container publishes when {@link exposedPublicly} is true.
  exposedPort: number | null;
  // Per-database limits, the exact {@link ResourceLimits} shape apps use, applied
  // on the next provision/reroute (lib/deploy/resources.ts).
  resources: ResourceLimits | null;
  // Expert override: full image ref replacing the derived engine image
  // (`DB_IMAGES[type](version)`); {@link version} is inert while set.
  customImage: string | null;
  // Expert override: REPLACES the container command verbatim. Redis's default
  // carries `--requirepass <password>` - omitting it drops auth, so the UI warns.
  customCommand: string | null;
  // Cron jobs are ON for this database - the same opt-in switch, and the same
  // reason it rides the DTO, as `apps.cronEnabled`.
  cronEnabled: boolean;
  // Expert override: the engine's own CONFIG FILES, written next to the stack and
  // bind-mounted into the container.
  mounts: DatabaseMount[];
  sizeMb: number;
  createdAt: string;
}

// DatabaseMount - one config file of a database: its name in the stack's files
// directory, its body, and where it lands inside the container.
export interface DatabaseMount {
  // Relative path inside the stack's files dir, e.g. "postgresql.conf".
  filePath: string;
  // The file's body, written verbatim.
  content: string;
  // Absolute in-container path the file is bind-mounted at.
  mountPath: string;
}
