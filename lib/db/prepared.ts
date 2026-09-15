import "server-only";

import { getDb, type DrizzleClient } from "./client";

const byClient = new WeakMap<object, Map<string, unknown>>();

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
