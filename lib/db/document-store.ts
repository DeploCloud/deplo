import "server-only";

import { getPool } from "./pg";
import type { DeploData } from "../types";

/**
 * Read/write the single control-plane document in Postgres.
 *
 * The whole `DeploData` object is stored as one JSONB row. This keeps the
 * existing synchronous data-access layer intact (it reads from an in-memory
 * cache hydrated from here) while making Postgres the durable system of record.
 */

const ROW_ID = "singleton";

async function ensureTable(): Promise<void> {
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS deplo_state (
       id text PRIMARY KEY,
       data jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
}

export async function loadDocument(): Promise<DeploData | null> {
  await ensureTable();
  const res = await getPool().query<{ data: DeploData }>(
    "SELECT data FROM deplo_state WHERE id = $1",
    [ROW_ID]
  );
  return res.rows[0]?.data ?? null;
}

export async function saveDocument(data: DeploData): Promise<void> {
  await ensureTable();
  await getPool().query(
    `INSERT INTO deplo_state (id, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = now()`,
    [ROW_ID, JSON.stringify(data)]
  );
}
