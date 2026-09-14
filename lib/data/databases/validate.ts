import "server-only";

import type { DatabaseType } from "../../types/database";

export const DEFAULT_PORTS: Record<DatabaseType, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  redis: 6379,
  clickhouse: 8123,
};

// defaultUserFor - the engine login used when the caller supplies no username.
export function defaultUserFor(type: DatabaseType): string {
  return type === "redis" ? "default" : "app";
}

const DB_NAME_MAX = 60;

// cleanDatabaseName - trim and bound a user-supplied DISPLAY name.
export function cleanDatabaseName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Database name is required.");
  if (trimmed.length > DB_NAME_MAX)
    throw new Error(
      `Database name must be ${DB_NAME_MAX} characters or fewer.`,
    );
  return trimmed;
}

// databaseSlug - the host-side slug: the compose project (`db-<slug>`), its
// container_name, its data volume and its DNS name all hang off it.
export function databaseSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!/[a-z0-9]/.test(slug))
    throw new Error("Name must contain at least one letter or number.");
  return slug;
}

// isDuplicateNameError - the `databases_team_name_uq` violation a concurrent
// create/rename can still lose to after our own pre-check passed.
export function isDuplicateNameError(e: unknown): boolean {
  return String((e as { message?: string })?.message ?? e).includes(
    "databases_team_name_uq",
  );
}

// sanitizeDbIdentifier - a portable, URL-safe SQL identifier, or null.
export function sanitizeDbIdentifier(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  if (!cleaned || /^[0-9]/.test(cleaned)) return null;
  return cleaned.slice(0, 63); // postgres identifier limit; also under mysql's 64
}

// assertPasswordSafe - `$` is interpolated out by docker-compose on the
// `- KEY=value` line this rides, and whitespace breaks the line and the YAML.
export function assertPasswordSafe(password: string): void {
  if (/[$\s\u0000-\u001f\u007f]/.test(password))
    throw new Error("Password may not contain $ or whitespace");
}

// isValidImageRef - an image reference the compose can carry as a plain scalar.
export function isValidImageRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/.test(ref);
}
