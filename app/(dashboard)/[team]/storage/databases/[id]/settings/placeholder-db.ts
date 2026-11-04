import type { DatabaseDTO } from "@/lib/data/databases/rows";

// What the settings loading states draw: a running Postgres, the most common engine.
export const PLACEHOLDER_DB: DatabaseDTO = {
  id: "",
  teamId: "",
  environmentId: null,
  name: "database",
  logo: null,
  type: "postgres",
  version: "17",
  username: "postgres",
  dbName: "postgres",
  status: "running",
  dataCopyError: "",
  migrationRunId: null,
  serverId: "a",
  host: "db-main",
  port: 5432,
  connectionStringMasked: "",
  exposedPublicly: false,
  exposedPort: null,
  resources: null,
  customImage: null,
  customCommand: null,
  cronEnabled: false,
  restartLoopGuard: true,
  restartLoopStoppedAt: null,
  mounts: [],
  sizeMb: 0,
  createdAt: "",
};

export const PLACEHOLDER_SERVERS = [
  { id: "a", name: "Server name", isDeploHost: false },
  { id: "b", name: "Other server", isDeploHost: false },
];
