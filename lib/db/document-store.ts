import "server-only";

import { getPool } from "./pg";
import type { DeploData } from "../types";

/**
 * Read/write the single control-plane document in Postgres.
 *
 * The whole `DeploData` object is stored as one JSONB row. This keeps the
 * existing synchronous data-access layer intact (it reads from an in-memory
 * cache hydrated from here) while making Postgres the durable system of record.
 *
 * Table creation is owned by the Drizzle migrations (`deplo_state` is declared in
 * `schema/legacy.ts`), NOT by on-demand DDL here. The old `CREATE TABLE IF NOT
 * EXISTS` was removed in relational-store Step 0 so a single regime owns the
 * schema; `db:migrate` must have run before these functions are reached (a known
 * operational TODO for non-Docker dev — PLAN §8 "Migration runs as an explicit
 * step").
 */

const ROW_ID = "singleton";

export async function loadDocument(): Promise<DeploData | null> {
  const res = await getPool().query<{ data: DeploData }>(
    "SELECT data FROM deplo_state WHERE id = $1",
    [ROW_ID]
  );
  return res.rows[0]?.data ?? null;
}

export async function saveDocument(data: DeploData): Promise<void> {
  await getPool().query(
    `INSERT INTO deplo_state (id, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = now()`,
    [ROW_ID, JSON.stringify(data)]
  );
}
