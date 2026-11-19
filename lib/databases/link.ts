import { appNetwork } from "../deploy/network";
import type { DatabaseType } from "../types/database";

export type DatabaseReach =
  "internal" | "public" | "other-environment" | "other-server" | "other-team";

interface Placement {
  teamId: string;
  environmentId: string | null;
  serverId: string;
  /** A loader that leaves it out gets "another server": the refusal, never the reach. */
  clusterId?: string | null;
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
  // On one cluster the name forwarders carry the name across members (ADR-0028 amendment).
  const sameCluster = app.clusterId != null && app.clusterId === db.clusterId;
  if (sameNetwork && (app.serverId === db.serverId || sameCluster))
    return "internal";
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

// `place` is "Project / Environment", null outside any.
interface Side extends Placement {
  name: string;
  place: string | null;
}

type Exposure = { exposedPublicly: boolean; exposedPort: number | null };

/** Why `app` cannot reach `db`, with the real names and what fixes it; null when it can. */
export function reachHint(app: Side, db: Side & Exposure): string | null {
  const reach = databaseReach(app, db);
  if (reachable(reach)) return null;
  if (reach === "other-team")
    return `${db.name} belongs to another team. Connect one of this team's databases instead.`;
  if (reach === "other-server")
    return `${db.name} runs on another server than ${app.name} and is not publicly reachable. Move one of them next to the other, or turn on public access for ${db.name}.`;
  const at = (place: string | null) =>
    place ? `in ${place}` : "outside any environment";
  const target = app.place
    ? `in ${app.place}, the same environment as ${app.name}`
    : `outside any environment, like ${app.name}`;
  const apart =
    app.serverId !== db.serverId &&
    !(app.clusterId != null && app.clusterId === db.clusterId);
  return `${db.name} is ${at(db.place)} and ${app.name} is ${at(app.place)}. To reach it, ${db.name} has to be ${target}${apart ? ", on the same server" : ""}, or have public access on.`;
}

export function unreachableMessage(
  key: string,
  app: Side,
  db: Side & Exposure,
): string {
  return `${key} comes from ${db.name}. ${reachHint(app, db) ?? ""}`.trim();
}
