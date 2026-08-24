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
 *
 * An import is not one write. It creates a project, its environments, a dozen
 * apps and their databases, then spends minutes copying gigabytes into their
 * volumes - and the whole run can still be reverted wholesale. Anything done to
 * one of those rows in the middle races the import for it: a deploy starts a
 * stack whose data is half here, a rename lands on a row the next step is about
 * to write, a delete removes a target the copy is still aiming at. None of that
 * fails loudly. It just produces a result nobody can explain afterwards.
 *
 * So `migration_run_id` on the row (migration 0119) is the whole mechanism, in
 * the same shape `apps.deleting_at` already uses: set by the run that CREATES
 * the row, cleared the moment that run leaves `running` by any door, and read by
 * one refusal at each gate. Reads stay open - looking at a service arriving is
 * exactly what somebody watching a migration wants to do.
 */

/**
 * Whether this async context IS the migration.
 *
 * Without it the marker would refuse the import's own next step: the import
 * creates apps through `createApp` and writes their volumes through
 * `setAppVolumes`, and both go through the same gates as a person clicking. Its
 * own store rather than a field on the identity, because production's cookie
 * path installs no identity at all - there is nothing to add a field to.
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
 *
 * One sentence, and it names the state rather than the permission: nobody is
 * being told they may not do this, they are being told to wait for something
 * that is visibly running.
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
 *
 * Apps and databases carry their marker into a gate that was already loading
 * them; a project or an environment is renamed and deleted by functions that
 * never read the row at all (a conditional UPDATE is enough for the rest of what
 * they do). One query is what that costs, and only on a mutation.
 *
 * It matters most for the destructive half: deleting a project mid-import takes
 * the environments and apps the run is still filling with it, and the run then
 * writes into rows that are on their way out.
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
