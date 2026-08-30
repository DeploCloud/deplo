// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import type { DatabaseType } from "../types";

/**
 * The repository each engine's OFFICIAL image lives at - the same repos
 * `DB_IMAGES` derives from, split out so a `customImage` can be recognised as
 * "still the official image, just pinned differently".
 */
export const DB_REPOS: Record<DatabaseType, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongo",
  redis: "redis",
  clickhouse: "clickhouse/clickhouse-server",
};

/**
 * The repo half of an image ref, as Docker Hub names it: `postgres:17`,
 * `library/postgres` and `docker.io/library/postgres` are all `postgres`.
 */
function repoOf(image: string): string {
  const ref = image.split("@")[0];
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  const repo = colon > slash ? ref.slice(0, colon) : ref;
  return repo.replace(/^docker\.io\//, "").replace(/^library\//, "");
}

/**
 * Is `image` the engine's official image at some tag or digest? A pinned
 * `postgres:18` still ships `pg_isready`, so it must keep a real probe.
 */
export function isOfficialEngineImage(
  type: DatabaseType,
  image: string | null | undefined,
): boolean {
  const s = image?.trim();
  if (!s) return false;
  return repoOf(s) === DB_REPOS[type];
}

/**
 * Does this image run a datastore? Read at creation to keep a stack's first
 * domain off its database. Only the engines Deplo itself provisions count.
 * ponytail: rabbitmq/elasticsearch/minio/kafka are not here - add them the day
 * one of them actually collects a domain, not before.
 */
export function isDatastoreImage(image: string | null | undefined): boolean {
  const s = image?.trim();
  if (!s) return false;
  return (Object.keys(DB_REPOS) as DatabaseType[]).some((type) =>
    isOfficialEngineImage(type, s),
  );
}
