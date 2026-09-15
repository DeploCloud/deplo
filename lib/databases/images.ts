import type { DatabaseType } from "../types/database";

export const DB_REPOS: Record<DatabaseType, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongo",
  redis: "redis",
  clickhouse: "clickhouse/clickhouse-server",
};

function repoOf(image: string): string {
  const ref = image.split("@")[0];
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  const repo = colon > slash ? ref.slice(0, colon) : ref;
  return repo.replace(/^docker\.io\//, "").replace(/^library\//, "");
}

export function isOfficialEngineImage(
  type: DatabaseType,
  image: string | null | undefined,
): boolean {
  const s = image?.trim();
  if (!s) return false;
  return repoOf(s) === DB_REPOS[type];
}

// ponytail: rabbitmq/elasticsearch/minio/kafka are not here - add them the day
export function isDatastoreImage(image: string | null | undefined): boolean {
  const s = image?.trim();
  if (!s) return false;
  return (Object.keys(DB_REPOS) as DatabaseType[]).some((type) =>
    isOfficialEngineImage(type, s),
  );
}
