import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { isDeploHostServer } from "../../deploy/domains";
import { nowIso } from "../../ids";
import { recordActivity } from "../activity";
import { requireAdminServer } from "../servers/roster";
import { getUpdateInfo, type UpdateInfo } from "../updates";
import { tryPassThisStop } from "./decision";

/** Lets the update stop pass without a server that has not connected (ADR-0041); its apps and settings stay. */
export async function leaveServerBehind(id: string): Promise<UpdateInfo> {
  const { teamId, user, server } = await requireAdminServer(id);
  if (isDeploHostServer(server))
    throw new Error(
      `${server.name} is the machine Deplo runs on, so it can't be left behind. It connects on its own once its server agent is up to date.`,
    );
  if (server.firstLinkedAt)
    throw new Error(
      `${server.name} has already connected to Deplo, so the update isn't waiting on it.`,
    );
  if (!server.agent?.certFingerprint || server.importOnly)
    throw new Error(`The update isn't waiting on ${server.name}.`);

  const left = await getDb()
    .update(serversTable)
    .set({ leftBehindAt: nowIso() })
    .where(
      and(
        eq(serversTable.id, id),
        isNull(serversTable.leftBehindAt),
        isNull(serversTable.firstLinkedAt),
      ),
    )
    .returning({ id: serversTable.id });
  if (left.length > 0) {
    await recordActivity(
      "server",
      `Left server ${server.name} behind, so Deplo can update without it`,
      user.name,
      null,
      teamId,
    );
    await tryPassThisStop();
  }
  return getUpdateInfo();
}
