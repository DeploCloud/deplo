import type { DatabaseType } from "../types/database";

// DB_REPOS - the official image repo per engine, so a customImage can be recognised as still official.
export const DB_REPOS: Record<DatabaseType, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongo",
  redis: "redis",
  clickhouse: "clickhouse/clickhouse-server",
};

// Docker Hub names them alike: postgres:17, library/postgres and docker.io/library/postgres are all `postgres`.
function repoOf(image: string): string {
  const ref = image.split("@")[0];
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  const repo = colon > slash ? ref.slice(0, colon) : ref;
  return repo.replace(/^docker\.io\//, "").replace(/^library\//, "");
}

// isOfficialEngineImage - the official image at any tag or digest; a pinned `postgres:18` still ships `pg_isready`, so it keeps a real probe.
export function isOfficialEngineImage(
  type: DatabaseType,
  image: string | null | undefined,
): boolean {
  const s = image?.trim();
  if (!s) return false;
  return repoOf(s) === DB_REPOS[type];
}

// isDatastoreImage - true only for an engine Deplo provisions; read at creation to keep a stack's first domain off its database.
// ponytail: rabbitmq/elasticsearch/minio/kafka are not here - add them the day
// one of them actually collects a domain, not before.
export function isDatastoreImage(image: string | null | undefined): boolean {
  const s = image?.trim();
  if (!s) return false;
  return (Object.keys(DB_REPOS) as DatabaseType[]).some((type) =>
    isOfficialEngineImage(type, s),
  );
}
