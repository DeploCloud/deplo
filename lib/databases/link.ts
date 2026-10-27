import { appNetwork } from "../deploy/network";
import type { DatabaseType } from "../types/database";

export type DatabaseReach =
  "internal" | "public" | "other-environment" | "other-server" | "other-team";

interface Placement {
  teamId: string;
  environmentId: string | null;
  serverId: string;
}

// Conventional names: DATABASE_URL (12-factor), MONGODB_URI (MongoDB's own), REDIS_URL.
export const DEFAULT_LINK_KEY: Record<DatabaseType, string> = {
  postgres: "DATABASE_URL",
  mysql: "DATABASE_URL",
  mariadb: "DATABASE_URL",
  mongodb: "MONGODB_URI",
  redis: "REDIS_URL",
  clickhouse: "CLICKHOUSE_URL",
};

export function databaseReach(
  app: Placement,
  db: Placement & { exposedPublicly: boolean; exposedPort: number | null },
): DatabaseReach {
  if (app.teamId !== db.teamId) return "other-team";
  const sameNetwork = appNetwork(app) === appNetwork(db);
  if (sameNetwork && app.serverId === db.serverId) return "internal";
  if (db.exposedPublicly && db.exposedPort != null) return "public";
  return sameNetwork ? "other-server" : "other-environment";
}

export function reachable(reach: DatabaseReach): boolean {
  return reach === "internal" || reach === "public";
}

export const REACH_LABEL: Record<DatabaseReach, string> = {
  internal: "Private network",
  public: "Via public address",
  "other-environment": "In another environment",
  "other-server": "On another server",
  "other-team": "In another team",
};

export function unreachableMessage(
  key: string,
  database: string,
  reach: DatabaseReach,
): string {
  const where =
    reach === "other-team"
      ? "belongs to another team"
      : reach === "other-server"
        ? "runs on another server"
        : "is in another environment";
  const fix =
    reach === "other-team"
      ? "Disconnect it and connect one of this team's databases."
      : "Move one of them next to the other, or turn on public access for the database.";
  return `${key} comes from ${database}, which ${where} and is not publicly reachable. ${fix}`;
}
