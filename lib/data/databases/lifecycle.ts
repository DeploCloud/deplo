import "server-only";

import { eq } from "drizzle-orm";

import { getServerById } from "../servers/roster";
import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { getCurrentUser } from "../../auth/current-user";
import { requireCapability } from "../../membership";
import { recordActivity } from "../activity";
import { connectAgent } from "../../infra/agent-client/connect";
import { withKeyedLock } from "../keyed-mutex";
import { enqueueTeardowns } from "../teardown-queue";
import { assertDataCopyIntact, clearDataCopyError } from "../data-copy";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import { assertNotProvisioning, databaseExists, requireDatabase } from "./rows";
import {
  databasePassword,
  renderDatabaseStackYaml,
  rerouteDatabase,
  rerouteRequest,
  teardownDatabaseStack,
} from "./stack";

export async function setDatabaseRunning(
  id: string,
  running: boolean,
): Promise<void> {
  const teamId = (await requireCapability("control_databases")).teamId;
  const db = await requireDatabase(id, teamId);
  const host = db.host;
  const serverId = db.serverId;
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    assertNotProvisioning(cur, "starting or stopping it");
    // Reroute before starting: compose start returns the container to the network it was CREATED on.
    if (running && (await rerouteDatabase(id)) === "rerouted") {
      await getDb()
        .update(databasesTable)
        .set({ status: "running" })
        .where(eq(databasesTable.id, id));
      publishDatabaseChanged(id);
      return;
    }
    const conn = await connectAgent(serverId);
    try {
      const res = running
        ? await conn.startStack(host)
        : await conn.stopStack(host);
      if (!res.ok)
        throw new Error(
          res.error ||
            `agent failed to ${running ? "start" : "stop"} the database`,
        );
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: running ? "running" : "stopped" })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
  });
}

export async function restartDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("control_databases")).teamId;
  const user = (await getCurrentUser())!;
  let name = "";
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    name = cur.name;
    assertNotProvisioning(cur, "restarting it");
    assertDataCopyIntact(cur.name, cur.dataCopyError);
    const conn = await connectAgent(cur.serverId);
    try {
      const stop = await conn.stopStack(cur.host);
      if (!stop.ok)
        throw new Error(stop.error || "agent failed to stop the database");
      const start = await conn.startStack(cur.host);
      if (!start.ok)
        throw new Error(start.error || "agent failed to start the database");
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    `Restarted database ${name}`,
    user.name,
    null,
    teamId,
    null,
    id,
  );
}

export async function redeployDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("control_databases")).teamId;
  const user = (await getCurrentUser())!;
  let name = "";
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    name = cur.name;
    assertNotProvisioning(cur, "redeploying it");
    assertDataCopyIntact(cur.name, cur.dataCopyError);
    // Redis auth rides a --requirepass flag re-applied on every boot, so an empty password disables it.
    const password = databasePassword(cur);
    const yaml = renderDatabaseStackYaml(cur, password);
    const conn = await connectAgent(cur.serverId);
    try {
      const res = await conn.reroute(rerouteRequest(cur, yaml));
      if (!res.ok)
        throw new Error(res.error || "agent failed to redeploy the database");
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    `Redeployed database ${name}`,
    user.name,
    null,
    teamId,
    null,
    id,
  );
}

export async function rebuildDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("delete_databases")).teamId;
  const user = (await getCurrentUser())!;
  let name = "";
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    name = cur.name;
    assertNotProvisioning(cur, "rebuilding it");
    const password = databasePassword(cur);
    const yaml = renderDatabaseStackYaml(cur, password);
    const conn = await connectAgent(cur.serverId);
    try {
      const down = await conn.destroyStack(cur.host, true);
      if (!down.ok)
        throw new Error(down.error || "agent failed to tear down the database");
      const up = await conn.reroute(rerouteRequest(cur, yaml));
      if (!up.ok) {
        await getDb()
          .update(databasesTable)
          .set({ status: "error" })
          .where(eq(databasesTable.id, id));
        publishDatabaseChanged(id);
        throw new Error(
          up.error || "agent failed to re-provision the database",
        );
      }
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
    await clearDataCopyError({ kind: "database", id });
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    `Rebuilt database ${name} from scratch (data volume wiped)`,
    user.name,
    null,
    teamId,
    "database_rebuilt",
    id,
  );
}

export async function deleteDatabase(
  id: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const { membership } = await requireCapability("delete_databases");
  const user = (await getCurrentUser())!;
  const db = await requireDatabase(id, membership.teamId);
  const server = await getServerById(db.serverId);
  const where = server ? server.name : "its server";
  await withKeyedLock(id, async () => {
    if (!(await databaseExists(id))) return;
    let failure: { why: string; retry: string } | null = null;
    try {
      const reason = await teardownDatabaseStack(db);
      if (reason)
        failure = {
          why: `${where} could not remove it: ${reason}`,
          retry: "Try again",
        };
    } catch (e) {
      failure = {
        why: `${where} could not be reached (${e instanceof Error ? e.message : String(e)})`,
        retry: `Try again once ${where} is back online`,
      };
    }
    if (failure) {
      console.warn(`[databases] teardown of ${db.host} failed: ${failure.why}`);
      // Nothing is removed from Deplo unless the host proved the container and the volume are gone.
      if (!opts.force)
        throw new Error(
          `${db.name} was NOT deleted: ${failure.why}. Nothing has been removed ` +
            `from Deplo. ${failure.retry}, or delete it anyway and Deplo will ` +
            `keep retrying the teardown on that host.`,
        );
      // Forced: the row goes now and the queue keeps retrying until the host confirms both are gone.
      await enqueueTeardowns([
        {
          serverId: db.serverId,
          deployKey: db.host,
          projectLabel: db.id,
          label: db.name,
          teamId: db.teamId,
        },
      ]);
    }
    await getDb().delete(databasesTable).where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
    await recordActivity(
      "database",
      failure
        ? `Deleted database ${db.name} from Deplo, but ${failure.why}. Deplo ` +
            `will retry the teardown of its container and volume on ${where}.`
        : `Deleted database ${db.name}`,
      user.name,
      null,
      db.teamId,
      "database_deleted",
      null,
    );
  });
}
