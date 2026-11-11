import type { ID } from "./identity";
import type { ResourceLimits } from "./container";

export type DatabaseType =
  "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" | "clickhouse";

export type DatabaseStatus = "running" | "stopped" | "provisioning" | "error";

export interface Database {
  id: ID;
  teamId: ID;
  environmentId: ID | null;
  name: string;
  logo: string | null;
  type: DatabaseType;
  version: string;
  username: string;
  dbName: string;
  status: DatabaseStatus;
  dataCopyError: string;
  migrationRunId: ID | null;
  /** The server it runs on now; for a database on a cluster, the member the leader placed it on. */
  serverId: ID;
  /** The cluster it is placed on; null or absent for a database on one server. */
  clusterId?: ID | null;
  host: string;
  port: number;
  connectionStringEnc: string;
  exposedPublicly: boolean;
  exposedPort: number | null;
  resources: ResourceLimits | null;
  customImage: string | null;
  customCommand: string | null;
  cronEnabled: boolean;
  restartLoopGuard: boolean;
  restartLoopStoppedAt: string | null;
  mounts: DatabaseMount[];
  sizeMb: number;
  /** Artifact bytes per second of the last restore; null until one was measured. */
  restoreBytesPerSec?: number | null;
  /** When its change log last reached the backup destination; null while it is not archived. */
  walArchivedAt?: string | null;
  /** On a cluster: a copy on another member follows it, and a failover promotes that copy. */
  standby?: boolean;
  /** Marks the copy made last, so a member never starts one over data it did not seed. */
  standbySeed?: string | null;
  createdAt: string;
}

export interface DatabaseMount {
  filePath: string;
  content: string;
  mountPath: string;
}
