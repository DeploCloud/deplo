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

// revealRecoveryKey hands over the age identity in the clear - one of the two sanctioned
// exceptions to "never add a show-secret affordance".
export async function revealRecoveryKey(id: string): Promise<{
  name: string;
  recipient: string;
  identity: string;
  where: string;
}> {
  const { teamId } = await requireCapability("manage_backup_destinations");
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Not found");
  // On the KEYPAIR, not on the kind.
  if (!d.ageIdentityEnc || !d.ageRecipient)
    throw new Error(
      "This destination's backups are not encrypted, so it has no recovery key",
    );
  const user = (await getCurrentUser())!;
  // Decrypt FIRST: the stamp silences the "save your recovery key" nudge, and setting
  // it before we know there is a key to hand over left the destination looking safe
  // while nobody held anything.
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
  // Loud in the Activity trail: this hands over the ability to read every artifact at
  // that destination, so "who took it and when" is answerable in the UI.
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

// Where the artifacts this key opens actually LIVE, in one line, for the key file itself.
async function artifactLocation(d: BackupDestination): Promise<string> {
  if (d.kind === "s3")
    return `bucket "${d.bucket ?? ""}" at ${d.endpoint ?? ""}`;
  const dto = await withServerName(d);
  const host = dto.serverName ?? "a server that is no longer in the fleet";
  // `resolvedPath` is the only one that names the managed folder - `path` is null for
  // every destination that did not ask for a custom one.
  const folder = d.resolvedPath ?? d.path;
  return folder
    ? `${host}, in ${folder}`
    : `${host}, in the agent's managed backups folder`;
}
