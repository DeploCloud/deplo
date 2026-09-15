import "server-only";

import { decryptSecretOrThrow } from "../../crypto";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { newId } from "../../ids";
import { isMigrationPlatform } from "../../migration/source";
import type { MigrationPlatform } from "../../migration/source";
import { MIGRATION_HEARTBEAT_STALE_MS } from "../../types/migration";

export const leaseFor = (runId: string) => `dokploy-migration:${runId}`;

export const STALE_MS = MIGRATION_HEARTBEAT_STALE_MS;
export const IDLE_TICK_MS = 15_000;
export const PROGRESS_MS = 1_000;

export const owner = `${process.pid}-${newId("run")}`;

export const inflight = new Set<string>();

export type RunRow = typeof runsTable.$inferSelect;

export const lostLeases = new Set<string>();

export class LeaseLost extends Error {
  constructor(runId: string) {
    super(`another control plane took over migration ${runId}`);
  }
}

export interface RunCredential {
  kind: MigrationPlatform;
  url: string;
  apiKey: string;
}

export function panelNameFor(row: { platform: string }): string {
  return row.platform === "coolify" ? "Coolify" : "Dokploy";
}

export async function credentialFor(row: RunRow): Promise<RunCredential> {
  if (!row.apiKeyEnc)
    throw new Error(
      "This run has no stored key, so Deplo cannot carry on with it. Start it again.",
    );
  return {
    kind: isMigrationPlatform(row.platform) ? row.platform : "dokploy",
    url: row.sourceUrl,
    apiKey: decryptSecretOrThrow(row.apiKeyEnc, "the panel's API token"),
  };
}
