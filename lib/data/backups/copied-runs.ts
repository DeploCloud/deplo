import { isNull } from "drizzle-orm";

import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";

// ADR-0035: a run copied from another Deplo names that Deplo's file. Here only its row is ever deleted.
export function ownsArtifact(run: {
  status: string;
  objectKey: string | null;
  copiedFrom: string | null;
}): boolean {
  return run.status === "success" && !!run.objectKey && run.copiedFrom === null;
}

export const notCopied = isNull(backupRunsTable.copiedFrom);
