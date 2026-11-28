import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { migrationRunItems as runItemsTable } from "../db/schema/control-plane/migration";
import { nowIso } from "../ids";
import { recordActivity } from "./activity";
import { getCurrentUser } from "../auth/current-user";
import { requireCapability } from "../membership";
import { loadAppGraph } from "./app-graph-load";
import { requireAppCapability } from "./node-access";
import { appOwnVolumeNames } from "./project-backup-descriptor";
import { teardownOrQueue } from "./teardown-queue";
import { setAsideHeldCopy } from "./app-migration";
import { redeploy } from "./deployments/stack-actions";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { messageOf } from "../utils";

export function assertDataCopyIntact(
  name: string,
  dataCopyError: string,
): void {
  if (!dataCopyError) return;
  throw new Error(
    `${name}'s data did not come across: ${dataCopyError}. Starting it now would ` +
      `run it on empty storage. Bring the data over yourself, or choose ` +
      `"Deploy anyway" on its page to accept starting without it.`,
  );
}

export type DataCopyTarget = { kind: "app" | "database"; id: string };

export async function markDataCopyFailed(
  target: DataCopyTarget,
  message: string,
  opts?: { unlessCopiedIn?: string },
): Promise<void> {
  if (
    opts?.unlessCopiedIn &&
    (await dataAlreadyCopiedInto(opts.unlessCopiedIn, target.id))
  )
    return;
  const text = message.trim() || "the copy failed";
  try {
    if (target.kind === "app")
      await getDb()
        .update(appsTable)
        .set({ dataCopyError: text, updatedAt: nowIso() })
        .where(eq(appsTable.id, target.id));
    else
      await getDb()
        .update(databasesTable)
        .set({ dataCopyError: text })
        .where(eq(databasesTable.id, target.id));
  } catch {}
}

export async function dataAlreadyCopiedInto(
  runId: string,
  targetId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: runItemsTable.id })
    .from(runItemsTable)
    .where(
      and(
        eq(runItemsTable.runId, runId),
        eq(runItemsTable.targetId, targetId),
        eq(runItemsTable.sourceKind, "volume"),
        eq(runItemsTable.outcome, "created"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function clearDataCopyError(
  target: DataCopyTarget,
): Promise<void> {
  try {
    if (target.kind === "app")
      await getDb()
        .update(appsTable)
        .set({ dataCopyError: "", updatedAt: nowIso() })
        .where(eq(appsTable.id, target.id));
    else
      await getDb()
        .update(databasesTable)
        .set({ dataCopyError: "" })
        .where(eq(databasesTable.id, target.id));
  } catch {}
}

let deployAnyway = async (appId: string): Promise<string> =>
  (await redeploy(appId)).id;

/** Test seam: what "Deploy anyway" starts; the deploy's own id comes back. */
export function __setDeployAnywayForTest(
  fn?: (appId: string) => Promise<string>,
): void {
  deployAnyway = fn ?? (async (appId) => (await redeploy(appId)).id);
}

export async function acceptDataCopyLoss(
  target: DataCopyTarget,
): Promise<void> {
  const user = (await getCurrentUser())!;
  if (target.kind === "app") {
    const { membership } = await requireAppCapability(target.id, "deploy_apps");
    const app = await loadAppGraph(target.id);
    const heldMove =
      app?.teamId === membership.teamId ? app.migrateFromServerId : null;
    const [row] = await getDb()
      .update(appsTable)
      .set({
        dataCopyError: "",
        migrateFromServerId: null,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(appsTable.id, target.id),
          eq(appsTable.teamId, membership.teamId),
        ),
      )
      .returning({ name: appsTable.name });
    if (!row) throw new Error("App not found");
    const asideHeld = !!(app && heldMove && app.clusterId);
    if (app && heldMove && !asideHeld)
      await teardownOrQueue({
        serverId: heldMove,
        deployKey: app.slug,
        projectLabel: app.id,
        label: app.name,
        teamId: app.teamId,
        reclaimVolumes: appOwnVolumeNames(app),
      }).catch(() => {});
    const without = heldMove
      ? "without the data its previous server still holds"
      : "without the data a migration could not copy";
    await recordActivity(
      "app",
      `Accepted that ${row.name} starts ${without}${asideHeld ? ": Deplo sets that copy aside, never deletes it" : ""}`,
      user.name,
      target.id,
    );
    // The same click deploys it; Activity says "Deployed" only once that deploy is done.
    const deploy = () =>
      void deployAnyway(target.id)
        .then((depId) =>
          sayWhenDeployed(depId, row.name, without, user.name, target.id),
        )
        .catch((e) =>
          recordActivity(
            "app",
            `Could not deploy ${row.name} ${without}: ${messageOf(e)}`,
            user.name,
            target.id,
          ),
        )
        .catch(() => {});
    // In a cluster the old copy is set aside, never deleted (ADR-0046): its old copy stops before the new one starts.
    if (app && heldMove && asideHeld) {
      let started = false;
      const once = () => {
        if (started) return;
        started = true;
        deploy();
      };
      void setAsideHeldCopy({ ...app, migrateFromServerId: heldMove }, once)
        .then((note) => recordActivity("app", note, user.name, target.id))
        .catch(() => {})
        .finally(once);
    } else deploy();
    return;
  }
  const { teamId } = await requireCapability("control_databases");
  const [row] = await getDb()
    .update(databasesTable)
    .set({ dataCopyError: "" })
    .where(
      and(eq(databasesTable.id, target.id), eq(databasesTable.teamId, teamId)),
    )
    .returning({ name: databasesTable.name });
  if (!row) throw new Error("Database not found");
  await recordActivity(
    "database",
    `Accepted that ${row.name} starts without the data a migration could not copy`,
    user.name,
    null,
    teamId,
    null,
    target.id,
  );
}

// How often a deploy's outcome is read, and for how long: a deploy has 30 minutes.
const DEPLOYED_POLL_MS = 2_000;
const DEPLOYED_WAIT_MS = 35 * 60_000;

/** Says in Activity how the deploy "Deploy anyway" started ended, once it has. */
export async function sayWhenDeployed(
  depId: string,
  name: string,
  without: string,
  actor: string,
  appId: string,
): Promise<void> {
  for (const end = Date.now() + DEPLOYED_WAIT_MS; Date.now() < end;) {
    const [d] = await getDb()
      .select({ status: deploymentsTable.status })
      .from(deploymentsTable)
      .where(eq(deploymentsTable.id, depId))
      .limit(1);
    if (!d) return;
    if (d.status === "ready")
      return recordActivity("app", `Deployed ${name} ${without}`, actor, appId);
    if (d.status === "error" || d.status === "canceled")
      return recordActivity(
        "app",
        `The deploy of ${name} ${without} ${d.status === "error" ? "failed: its log says why" : "was canceled"}`,
        actor,
        appId,
      );
    await new Promise((r) => setTimeout(r, DEPLOYED_POLL_MS).unref?.());
  }
}
