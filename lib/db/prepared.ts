import "server-only";

import { getDb, type DrizzleClient } from "./client";

const byClient = new WeakMap<object, Map<string, unknown>>();

/**
 * Build a drizzle query once per client and reuse it: the SQL text and parameter
 * mapping are the expensive part of every read on the identity path. Unnamed on
 * purpose, so a pooler in transaction mode keeps working.
 */
export function prepared<T>(
  key: string,
  build: (db: DrizzleClient) => { prepare(name: string): T },
): T {
  const db = getDb();
  let byKey = byClient.get(db);
  if (!byKey) byClient.set(db, (byKey = new Map()));
  let query = byKey.get(key) as T | undefined;
  if (!query)
    byKey.set(key, (query = build(db).prepare(undefined as unknown as string)));
  return query;
}
