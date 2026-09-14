import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";

// Its own store rather than a field on the identity: the cookie path installs none.
const STORE_KEY = Symbol.for("deplo.migration-context.als");
const g = globalThis as unknown as {
  [STORE_KEY]?: AsyncLocalStorage<true>;
};
const store: AsyncLocalStorage<true> = (g[STORE_KEY] ??=
  new AsyncLocalStorage<true>());

// runAsMigration runs the import's own writes, exempt from the marker they set.
export function runAsMigration<T>(fn: () => T): T {
  return store.run(true, fn);
}

// inMigration is true inside runAsMigration.
export function inMigration(): boolean {
  return store.getStore() === true;
}

// assertNotMigrating is THE refusal, at every gate guarding a row an import can create.
export function assertNotMigrating(
  what: string,
  name: string,
  migrationRunId: string | null | undefined,
): void {
  if (!migrationRunId || inMigration()) return;
  throw new Error(
    `${name} is still being brought over by a migration. Wait for it to finish, ` +
      `or stop it from Settings → System → Migrations - until then this ${what} is the ` +
      `migration's to write.`,
  );
}

// assertContainerNotMigrating is the same refusal for a CONTAINER, which needs a read.
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
