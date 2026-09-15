import type { DatabaseType } from "@/lib/types/database";

export const DB_TYPES: {
  id: DatabaseType;
  name: string;
  versions: string[];
}[] = [
  { id: "postgres", name: "PostgreSQL", versions: ["18", "17", "16"] },
  { id: "mysql", name: "MySQL", versions: ["8.4", "8.0"] },
  { id: "mariadb", name: "MariaDB", versions: ["11", "10"] },
  { id: "mongodb", name: "MongoDB", versions: ["8", "7"] },
  { id: "redis", name: "Redis", versions: ["8", "7"] },
  { id: "clickhouse", name: "ClickHouse", versions: ["25.8", "25.3", "24"] },
];

export const DB_NAMES = Object.fromEntries(
  DB_TYPES.map((t) => [t.id, t.name]),
) as Record<DatabaseType, string>;

export const DB_LOGOS: Record<DatabaseType, string> = {
  postgres: "/engines/postgres.svg",
  mysql: "/engines/mysql.svg",
  mariadb: "/engines/mariadb.svg",
  mongodb: "/engines/mongodb.svg",
  redis: "/engines/redis.svg",
  clickhouse: "/engines/clickhouse.svg",
};

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
