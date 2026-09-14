import type { DatabaseType } from "@/lib/types/database";

// DB_TYPES - the engine catalogue shared by the create and the edit dialogs.
export const DB_TYPES: {
  id: DatabaseType;
  name: string;
  versions: string[];
}[] = [
  // Offline fallback + default (versions[0]) only: DbVersionInput fetches the live Docker Hub tag list.
  { id: "postgres", name: "PostgreSQL", versions: ["18", "17", "16"] },
  { id: "mysql", name: "MySQL", versions: ["8.4", "8.0"] },
  { id: "mariadb", name: "MariaDB", versions: ["11", "10"] },
  { id: "mongodb", name: "MongoDB", versions: ["8", "7"] },
  { id: "redis", name: "Redis", versions: ["8", "7"] },
  // ClickHouse publishes no bare-major tag ("25" and "26" are both 404), so the default is minor-qualified.
  { id: "clickhouse", name: "ClickHouse", versions: ["25.8", "25.3", "24"] },
];

// DB_NAMES - engine id → proper display name ("postgres" → "PostgreSQL").
export const DB_NAMES = Object.fromEntries(
  DB_TYPES.map((t) => [t.id, t.name]),
) as Record<DatabaseType, string>;

// DB_LOGOS - brand marks bundled under `/public/engines`: the dashboard CSP is `img-src 'self' blob: data:`, never a remote fetch.
export const DB_LOGOS: Record<DatabaseType, string> = {
  postgres: "/engines/postgres.svg",
  mysql: "/engines/mysql.svg",
  mariadb: "/engines/mariadb.svg",
  mongodb: "/engines/mongodb.svg",
  redis: "/engines/redis.svg",
  clickhouse: "/engines/clickhouse.svg",
};

// ENGINE_CREDS - which credential inputs each engine's official image supports as first-init env vars, plus the blank-field default.
export const ENGINE_CREDS: Record<
  DatabaseType,
  { username: boolean; userDefault: string; dbName: boolean; password: boolean }
> = {
  postgres: {
    username: true,
    userDefault: "app",
    dbName: true,
    password: true,
  },
  mysql: { username: true, userDefault: "app", dbName: true, password: true },
  mariadb: { username: true, userDefault: "app", dbName: true, password: true },
  mongodb: {
    username: true,
    userDefault: "app",
    dbName: false,
    password: true,
  },
  clickhouse: {
    username: true,
    userDefault: "app",
    dbName: true,
    password: true,
  },
  redis: {
    username: false,
    userDefault: "default",
    dbName: false,
    password: true,
  },
};
