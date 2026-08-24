import type { DatabaseType } from "@/lib/types";

/**
 * The engine catalogue shared by the create dialog (which engines/versions to
 * offer) and the edit dialog (icon + label for the read-only summary). One source
 * so the two never drift on the engine list or icons.
 */
export const DB_TYPES: {
  id: DatabaseType;
  name: string;
  versions: string[];
}[] = [
  // These lists are only the OFFLINE FALLBACK + default (versions[0]) for the
  // create dialog — the real version picker (DbVersionInput) fetches the live
  // tag list from Docker Hub via /api/database-versions, so it tracks new
  // releases automatically. Keep the first entry a sensible current default.
  { id: "postgres", name: "PostgreSQL", versions: ["18", "17", "16"] },
  { id: "mysql", name: "MySQL", versions: ["8.4", "8.0"] },
  { id: "mariadb", name: "MariaDB", versions: ["11", "10"] },
  { id: "mongodb", name: "MongoDB", versions: ["8", "7"] },
  { id: "redis", name: "Redis", versions: ["8", "7"] },
  // ClickHouse publishes no bare-major tag ("25" and "26" are both 404) — the
  // shipped tags are minor-qualified, so the default has to be one of those.
  { id: "clickhouse", name: "ClickHouse", versions: ["25.8", "25.3", "24"] },
];

/** Engine id → proper display name ("postgres" → "PostgreSQL"), for card copy. */
export const DB_NAMES = Object.fromEntries(
  DB_TYPES.map((t) => [t.id, t.name]),
) as Record<DatabaseType, string>;

/**
 * Engine id → its REAL brand mark, bundled under `/public/engines` and served
 * from our own origin (the dashboard CSP is `img-src 'self' blob: data:` — no
 * remote fetch, ever). These are the engines' actual logos, not a stand-in
 * glyph: a database with no custom logo of its own shows the elephant, the
 * dolphin, the seal, the leaf.
 *
 * This is the DEFAULT, not the value: a database's uploaded logo (Settings →
 * General) always wins, and clearing it falls back here — the same
 * override-or-derive rule an App's logo follows. Rendered by
 * {@link file://./database-logo.tsx DatabaseLogo}, the only component that
 * should read this map.
 *
 * Provenance: dashboard-icons (homarr-labs, CC0) for every engine except MySQL,
 * whose mark there carries the wordmark and turns to mush at 36px — that one is
 * devicon's dolphin (MIT). Each was checked to stay legible on BOTH the light
 * and the dark tile background before it was picked; a mark that vanishes in one
 * theme (the navy MariaDB seal, the black ClickHouse bars) was rejected for the
 * brand's own light variant.
 */
export const DB_LOGOS: Record<DatabaseType, string> = {
  postgres: "/engines/postgres.svg",
  mysql: "/engines/mysql.svg",
  mariadb: "/engines/mariadb.svg",
  mongodb: "/engines/mongodb.svg",
  redis: "/engines/redis.svg",
  clickhouse: "/engines/clickhouse.svg",
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
