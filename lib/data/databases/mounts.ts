import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databaseMounts as databaseMountsTable } from "../../db/schema/control-plane/databases";
import { getCurrentUser } from "../../auth/current-user";
import { requireCapability } from "../../membership";
import { recordActivity } from "../activity";
import { connectAgent } from "../../infra/agent-client/connect";
import { DB_DATA_DIRS } from "../../deploy/database-compose";
import { withKeyedLock } from "../keyed-mutex";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import { requireDatabase } from "./rows";
import {
  databasePassword,
  renderDatabaseStackYaml,
  rerouteRequest,
} from "./stack";
import type { DatabaseMount, DatabaseType } from "../../types/database";

const MAX_MOUNT_BYTES = 1024 * 1024;

export function validateDatabaseMounts(
  type: DatabaseType,
  raw: DatabaseMount[],
): DatabaseMount[] {
  const dataDir = DB_DATA_DIRS[type].replace(/\/+$/, "");
  const seenFile = new Set<string>();
  const seenMount = new Set<string>();
  const out: DatabaseMount[] = [];
  for (const m of raw) {
    const filePath = (m.filePath ?? "")
      .trim()
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    if (!filePath || filePath.startsWith("/"))
      throw new Error(
        `The file name must be relative, for example "postgresql.conf": "${m.filePath}"`,
      );
    if (/[\s:]/.test(filePath))
      throw new Error(
        `A file name cannot contain spaces or ":": "${m.filePath}"`,
      );
    if (filePath.split("/").includes(".."))
      throw new Error(`A file name cannot contain "..": "${m.filePath}"`);

    const mountPath = (m.mountPath ?? "").trim().replace(/\/+$/, "");
    if (!/^\/[^\s:]*$/.test(mountPath) || mountPath.length < 2)
      throw new Error(
        `The path in the container must be absolute, with no spaces or ":": "${m.mountPath}"`,
      );
    if (mountPath.split("/").includes(".."))
      throw new Error(
        `The path in the container cannot contain "..": "${m.mountPath}"`,
      );
    if (mountPath === dataDir || mountPath.startsWith(dataDir + "/"))
      throw new Error(
        `${mountPath} is inside this engine's data directory (${dataDir}). A file there would be stored with the data and backed up with it - put the configuration somewhere else.`,
      );

    const content = m.content ?? "";
    if (Buffer.byteLength(content, "utf8") > MAX_MOUNT_BYTES)
      throw new Error(`${filePath} is too large to save (1 MiB max).`);

    if (seenFile.has(filePath))
      throw new Error(`Duplicate file name: "${filePath}"`);
    if (seenMount.has(mountPath))
      throw new Error(`Duplicate path in the container: "${mountPath}"`);
    seenFile.add(filePath);
    seenMount.add(mountPath);
    out.push({ filePath, content, mountPath });
  }
  return out;
}

export async function setDatabaseMounts(
  id: string,
  mounts: DatabaseMount[],
): Promise<void> {
  const { teamId } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;
  let name = "";
  await withKeyedLock(id, async () => {
    const cur = await requireDatabase(id, teamId);
    name = cur.name;
    const validated = validateDatabaseMounts(cur.type, mounts);

    await getDb().transaction(async (tx) => {
      await tx
        .delete(databaseMountsTable)
        .where(eq(databaseMountsTable.databaseId, id));
      if (validated.length > 0) {
        await tx.insert(databaseMountsTable).values(
          validated.map((m, position) => ({
            databaseId: id,
            position,
            filePath: m.filePath,
            content: m.content,
            mountPath: m.mountPath,
          })),
        );
      }
    });
    publishDatabaseChanged(id);

    if (cur.status === "provisioning") return;
    const password = databasePassword(cur);
    const next = { ...cur, mounts: validated };
    const conn = await connectAgent(cur.serverId);
    try {
      const res = await conn.reroute(
        rerouteRequest(next, renderDatabaseStackYaml(next, password)),
      );
      if (!res.ok)
        throw new Error(
          `The files were saved but the database could not be updated: ${
            res.error || "the agent refused the change"
          }. Press Redeploy to try again.`,
        );
    } finally {
      conn.close();
    }
  });
  await recordActivity(
    "database",
    `Updated the config files of ${name}`,
    user.name,
    null,
    teamId,
    null,
    id,
  );
}
