import "server-only";

import { DEPLO_VERSION, REQUIRED_STOP, versionAtLeast } from "../version";

// Raw SQL, so a later release can read the record on this schema before its own migrations run (ADR-0041).
export type RawQuery = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

// The installer greps a refused boot's log for this prefix and shows the rest of the line as the reason.
export const UPDATE_REFUSED = "[deplo] Update refused: ";

// instrumentation-node.ts matches the name, so a refusal logs only its own line.
export class UpdateRefusedError extends Error {
  override name = "UpdateRefusedError";
}

const tag = (v: string) => `v${v.replace(/^v/i, "")}`;

/** Why this release will not start: plain words naming the stop to install first. */
export function refusalReason(stop: string): string {
  return `Deplo ${tag(DEPLO_VERSION)} has to come after ${tag(stop)}. Update to ${tag(stop)} first and let it finish getting this instance ready.`;
}

/** A row passes every stop up to its own version: a stop, a later stop, or a fresh install. */
export function stopPassed(stop: string, passed: readonly string[]): boolean {
  return passed.some((v) => versionAtLeast(v, stop));
}

/** The passed stops, or none when the table does not exist yet (a release before ADR-0041). */
export async function readPassedStops(query: RawQuery): Promise<string[]> {
  const t = await query(
    "SELECT to_regclass('public.passed_update_stops')::text AS t",
  );
  if (!t.rows[0]?.t) return [];
  const r = await query("SELECT version FROM passed_update_stops");
  return r.rows.map((row) => String(row.version));
}

/** A database no migration has ever run on: a fresh install, which has passed every stop. */
export async function neverMigrated(query: RawQuery): Promise<boolean> {
  const t = await query(
    "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS t",
  );
  if (!t.rows[0]?.t) return true;
  const r = await query(
    "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
  );
  return Number(r.rows[0]?.n ?? 0) === 0;
}

/** After a fresh install's first migrations: past this release, so past every stop it knows. */
export async function passEveryStop(query: RawQuery): Promise<void> {
  for (const version of new Set([
    DEPLO_VERSION,
    REQUIRED_STOP ?? DEPLO_VERSION,
  ]))
    await query(
      "INSERT INTO passed_update_stops (version, passed_at) VALUES ($1, now()) ON CONFLICT (version) DO NOTHING",
      [version],
    );
}
