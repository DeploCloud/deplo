import "server-only";
import { redeployDatabase } from "../databases/lifecycle";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { connectAgent } from "../../infra/agent-client/connect";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import type { DatabaseType } from "../../types/database";

import { startStackOn } from "../volume-migration";

import type { Landed } from "./landed-targets";

const PROVISION_WAIT_MS = 5 * 60_000;
const HEALTH_WAIT_MS = 3 * 60_000;
const POLL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForProvision(
  databaseId: string,
  teamId: string,
): Promise<boolean> {
  const deadline = Date.now() + PROVISION_WAIT_MS;
  for (;;) {
    const rows = await getDb()
      .select({ status: databasesTable.status })
      .from(databasesTable)
      .where(
        and(
          eq(databasesTable.id, databaseId),
          eq(databasesTable.teamId, teamId),
        ),
      );
    const status = rows[0]?.status;
    if (!status) return false;
    if (status !== "provisioning") return true;
    if (Date.now() > deadline) return false;
    await sleep(POLL_MS);
  }
}

const CONTENT_COUNT: Partial<
  Record<
    DatabaseType,
    (a: { username: string; dbName: string }) => {
      command: string;
      noun: string;
    }
  >
> = {
  postgres: (a) => ({
    command: `psql -U ${a.username} -d ${a.dbName} -tAc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"`,
    noun: "table",
  }),
  mysql: (a) => ({
    command: `sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" -N -B -D ${a.dbName} -e "select count(*) from information_schema.tables where table_schema = database()"'`,
    noun: "table",
  }),
  mariadb: (a) => ({
    command: `sh -c 'mariadb -u root -p"$MARIADB_ROOT_PASSWORD" -N -B -D ${a.dbName} -e "select count(*) from information_schema.tables where table_schema = database()"'`,
    noun: "table",
  }),
  mongodb: () => ({
    command: `sh -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand({listDatabases:1}).databases.filter(d=>!/^(admin|local|config)$/.test(d.name)).reduce((a,d)=>a+db.getSiblingDB(d.name).getCollectionNames().length,0)"'`,
    noun: "collection",
  }),
  clickhouse: (a) => ({
    command: `clickhouse-client --query "select count(*) from system.tables where database = '${a.dbName}'"`,
    noun: "table",
  }),
};

export async function startAndVerifyDatabase(
  landed: Landed,
  teamId: string,
  copied: boolean,
): Promise<{ ok: boolean; message: string }> {
  const after = copied
    ? "The data was copied but "
    : "Nothing had to be copied, but ";
  try {
    await startStackOn(landed.targetServerId, landed.targetSlug);
  } catch (e) {
    const why = e instanceof Error ? e.message : "the host refused";
    if (!/no container/i.test(why))
      return {
        ok: false,
        message: `${after}${landed.targetName} would not start: ${why}`,
      };
    try {
      await redeployDatabase(landed.targetId);
    } catch (e2) {
      return {
        ok: false,
        message: `${after}${landed.targetName} was never set up on its server, and setting it up now failed: ${
          e2 instanceof Error ? e2.message : "the host refused"
        }`,
      };
    }
  }

  const conn = await connectAgent(landed.targetServerId);
  try {
    const deadline = Date.now() + HEALTH_WAIT_MS;
    let last = "";
    for (;;) {
      const instances = await conn
        .listInstances(landed.targetId, landed.targetSlug, "")
        .catch(() => []);
      const pick = instances.find((i) => i.running) ?? instances[0];
      if (pick?.running && (pick.health === "healthy" || pick.health === "")) {
        await setDatabaseRunningAfterCopy(landed.targetId, teamId);
        if (!copied)
          return {
            ok: true,
            message: `${landed.targetName} is back up. Nothing was copied into it, so it is the empty database Deplo created.`,
          };
        const counted = await countContent(conn, landed, pick.name, pick.image);
        return {
          ok: true,
          message: counted
            ? `${landed.targetName} is up on the copied data - ${counted}.`
            : `${landed.targetName} is up on the copied data.`,
        };
      }
      last = pick ? pick.health || pick.state || "starting" : "no container";
      if (Date.now() > deadline)
        return {
          ok: false,
          message: copied
            ? `The data was copied but ${landed.targetName} did not come up (${last}). Check its logs - a data directory written by a different engine version is the usual cause.`
            : `${landed.targetName} did not come back up after the copy step (${last}). Nothing was written to it. Check its logs.`,
        };
      await sleep(POLL_MS);
    }
  } finally {
    conn.close();
  }
}

async function countContent(
  conn: Awaited<ReturnType<typeof connectAgent>>,
  landed: Landed,
  container: string,
  image: string,
): Promise<string> {
  if (!landed.engine) return "";
  const ask = CONTENT_COUNT[landed.engine.type];
  if (!ask) return "";
  const { command, noun } = ask(landed.engine);
  try {
    const res = await conn.exec(landed.targetId, container, command, image);
    const value = res.stdout.trim().split(/\s+/).pop() ?? "";
    if (res.code !== 0 || !/^\d+$/.test(value)) return "";
    const n = Number(value);
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
  } catch {
    return "";
  }
}

async function setDatabaseRunningAfterCopy(
  databaseId: string,
  teamId: string,
): Promise<void> {
  await getDb()
    .update(databasesTable)
    .set({ status: "running" })
    .where(
      and(eq(databasesTable.id, databaseId), eq(databasesTable.teamId, teamId)),
    );
  publishDatabaseChanged(databaseId);
}
