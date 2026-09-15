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

export function defaultUserFor(type: DatabaseType): string {
  return type === "redis" ? "default" : "app";
}

const DB_NAME_MAX = 60;

export function cleanDatabaseName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Database name is required.");
  if (trimmed.length > DB_NAME_MAX)
    throw new Error(
      `Database name must be ${DB_NAME_MAX} characters or fewer.`,
    );
  return trimmed;
}

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

export function isDuplicateNameError(e: unknown): boolean {
  return String((e as { message?: string })?.message ?? e).includes(
    "databases_team_name_uq",
  );
}

export function sanitizeDbIdentifier(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  if (!cleaned || /^[0-9]/.test(cleaned)) return null;
  return cleaned.slice(0, 63);
}

export function assertPasswordSafe(password: string): void {
  if (/[$\s\u0000-\u001f\u007f]/.test(password))
    throw new Error("Password may not contain $ or whitespace");
}

export function isValidImageRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/.test(ref);
}
