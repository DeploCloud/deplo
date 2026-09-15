import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { requireCapability } from "../../membership";
import { recordActivity } from "../activity";
import { decryptSecret } from "../../crypto";
import { withServerName } from "./dto";
import { loadDestination } from "./listing";
import type { BackupDestination } from "../../types/backup";

export async function revealRecoveryKey(id: string): Promise<{
  name: string;
  recipient: string;
  identity: string;
  where: string;
}> {
  const { teamId } = await requireCapability("manage_backup_destinations");
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Not found");
  if (!d.ageIdentityEnc || !d.ageRecipient)
    throw new Error(
      "This destination's backups are not encrypted, so it has no recovery key",
    );
  const user = (await getCurrentUser())!;
  const identity = decryptSecret(d.ageIdentityEnc);
  if (!identity)
    throw new Error(
      "This destination's recovery key could not be read. It was encrypted with " +
        "a different DEPLO_SECRET, so the backups at this destination cannot be " +
        "decrypted by this instance either.",
    );
  await getDb()
    .update(destTable)
    .set({ recoveryKeySavedAt: nowIso() })
    .where(and(eq(destTable.id, id), eq(destTable.teamId, teamId)));
  await recordActivity(
    "s3",
    `Downloaded the recovery key for backup destination ${d.name}`,
    user.name,
    null,
    teamId,
  );
  return {
    name: d.name,
    recipient: d.ageRecipient ?? "",
    identity,
    where: await artifactLocation(d),
  };
}

async function artifactLocation(d: BackupDestination): Promise<string> {
  if (d.kind === "s3")
    return `bucket "${d.bucket ?? ""}" at ${d.endpoint ?? ""}`;
  const dto = await withServerName(d);
  const host = dto.serverName ?? "a server that is no longer in the fleet";
  const folder = d.resolvedPath ?? d.path;
  return folder
    ? `${host}, in ${folder}`
    : `${host}, in the agent's managed backups folder`;
}
