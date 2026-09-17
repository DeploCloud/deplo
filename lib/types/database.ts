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
  serverId: ID;
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
  createdAt: string;
}

export interface DatabaseMount {
  filePath: string;
  content: string;
  mountPath: string;
}
