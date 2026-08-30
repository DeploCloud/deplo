import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane";

/**
 * The rows a migration is still writing to, and the refusal that keeps everyone
 * else off them until it is done.
 */

/**
 * Whether this async context IS the migration. Its own store rather than a field
 * on the identity, because production's cookie path installs no identity at all -
 * there is nothing to add a field to.
 */
const STORE_KEY = Symbol.for("deplo.migration-context.als");
const g = globalThis as unknown as {
  [STORE_KEY]?: AsyncLocalStorage<true>;
};
const store: AsyncLocalStorage<true> = (g[STORE_KEY] ??=
  new AsyncLocalStorage<true>());

/** Run the import's own writes, exempt from the marker they are setting. */
export function runAsMigration<T>(fn: () => T): T {
  return store.run(true, fn);
}

/** True inside {@link runAsMigration}. */
export function inMigration(): boolean {
  return store.getStore() === true;
}

/**
 * THE refusal, at every gate that guards a row an import can create.
 */
export function assertNotMigrating(
  what: string,
  name: string,
  migrationRunId: string | null | undefined,
): void {
  if (!migrationRunId || inMigration()) return;
  throw new Error(
    `${name} is still being brought over by a migration. Wait for it to finish, ` +
      `or stop it from Settings → Migrations - until then this ${what} is the ` +
      `migration's to write.`,
  );
}

/**
 * The same refusal for a CONTAINER, which needs a read to make.
 */
export async function assertContainerNotMigrating(
  kind: "project" | "environment",
  id: string,
): Promise<void> {
  if (inMigration()) return;
  const table = kind === "project" ? projectsTable : environmentsTable;
  const [row] = await getDb()
    .select({ name: table.name, migrationRunId: table.migrationRunId })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (row) assertNotMigrating(kind, row.name, row.migrationRunId);
}
