import "server-only";

import { decryptSecretOrThrow } from "../../crypto";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { newId } from "../../ids";
import { isMigrationPlatform } from "../../migration/source";
import type { MigrationPlatform } from "../../migration/source";
import { MIGRATION_HEARTBEAT_STALE_MS } from "../../types/migration";

// leaseFor - one lease PER RUN, not one for the instance: two processes must
// not drive the SAME run, and the lease cannot mean anything else.
export const leaseFor = (runId: string) => `dokploy-migration:${runId}`;

// A heartbeat older than this is a control plane that died; take the run over.
export const STALE_MS = MIGRATION_HEARTBEAT_STALE_MS;
// IDLE_TICK_MS - how often the tick runs when nothing is going on.
export const IDLE_TICK_MS = 15_000;
// PROGRESS_MS - how often a copy in flight refreshes its byte count.
export const PROGRESS_MS = 1_000;

export const owner = `${process.pid}-${newId("run")}`;

// inflight - runs this process is driving right now. One `advance` per run,
// never two - and a long one never keeps the tick from picking up another.
export const inflight = new Set<string>();

export type RunRow = typeof runsTable.$inferSelect;

// lostLeases - runs whose lease another control plane took from under this one.
export const lostLeases = new Set<string>();

// LeaseLost - thrown out of a step when the lease is gone: the other owner finishes the run.
export class LeaseLost extends Error {
  constructor(runId: string) {
    super(`another control plane took over migration ${runId}`);
  }
}

// RunCredential - what a run needs to talk to its panel, for the length of one step.
export interface RunCredential {
  // Read from the run's row, never re-detected: a resume happens hours later,
  // and a detection that answered differently would point the data cutover at
  // the wrong API.
  kind: MigrationPlatform;
  url: string;
  apiKey: string;
}

// panelNameFor - the source product's name, for the `{panel}` a mapper's note carries.
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
