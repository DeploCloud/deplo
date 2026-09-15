import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";

const STORE_KEY = Symbol.for("deplo.migration-context.als");
const g = globalThis as unknown as {
  [STORE_KEY]?: AsyncLocalStorage<true>;
};
const store: AsyncLocalStorage<true> = (g[STORE_KEY] ??=
  new AsyncLocalStorage<true>());

export function runAsMigration<T>(fn: () => T): T {
  return store.run(true, fn);
}

export function inMigration(): boolean {
  return store.getStore() === true;
}

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
