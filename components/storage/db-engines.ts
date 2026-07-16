import {
  Database as DatabaseIcon,
  Leaf,
  MemoryStick,
  BarChart3,
  type LucideIcon,
} from "lucide-react";

import type { DatabaseType } from "@/lib/types";

/**
 * The engine catalogue shared by the create dialog (which engines/versions to
 * offer) and the edit dialog (icon + label for the read-only summary). One source
 * so the two never drift on the engine list or icons.
 */
export const DB_TYPES: {
  id: DatabaseType;
  name: string;
  icon: LucideIcon;
  versions: string[];
}[] = [
  // These lists are only the OFFLINE FALLBACK + default (versions[0]) for the
  // create dialog — the real version picker (DbVersionInput) fetches the live
  // tag list from Docker Hub via /api/database-versions, so it tracks new
  // releases automatically. Keep the first entry a sensible current default.
  { id: "postgres", name: "PostgreSQL", icon: DatabaseIcon, versions: ["18", "17", "16"] },
  { id: "mysql", name: "MySQL", icon: DatabaseIcon, versions: ["8.4", "8.0"] },
  { id: "mariadb", name: "MariaDB", icon: DatabaseIcon, versions: ["11", "10"] },
  { id: "mongodb", name: "MongoDB", icon: Leaf, versions: ["8", "7"] },
  { id: "redis", name: "Redis", icon: MemoryStick, versions: ["8", "7"] },
  { id: "clickhouse", name: "ClickHouse", icon: BarChart3, versions: ["25", "24"] },
];

export const DB_ICONS: Record<DatabaseType, LucideIcon> = {
  postgres: DatabaseIcon,
  mysql: DatabaseIcon,
  mariadb: DatabaseIcon,
  mongodb: Leaf,
  redis: MemoryStick,
  clickhouse: BarChart3,
};

/**
 * Which credential inputs each engine's official image actually supports as
 * first-init env vars, and the default the data layer falls back to when the
 * field is left blank (shown as the placeholder). Drives both the conditional
 * inputs on create and the read-only summary on edit.
 *
 * - `username`: does the image create a named login? (postgres POSTGRES_USER,
 *   mysql/mariadb MYSQL_USER, mongo MONGO_INITDB_ROOT_USERNAME, clickhouse
 *   CLICKHOUSE_USER). Redis has no user concept — auth is a single requirepass and
 *   the built-in ACL user is literally `default`.
 * - `dbName`: does the image create a named logical DB? Redis has none; mongo
 *   creates DBs lazily on first write, so we don't surface a DB-name field for it.
 * - `password`: every engine takes a password.
 */
export const ENGINE_CREDS: Record<
  DatabaseType,
  { username: boolean; userDefault: string; dbName: boolean; password: boolean }
> = {
  postgres: { username: true, userDefault: "app", dbName: true, password: true },
  mysql: { username: true, userDefault: "app", dbName: true, password: true },
  mariadb: { username: true, userDefault: "app", dbName: true, password: true },
  mongodb: { username: true, userDefault: "app", dbName: false, password: true },
  clickhouse: { username: true, userDefault: "app", dbName: true, password: true },
  redis: { username: false, userDefault: "default", dbName: false, password: true },
};
