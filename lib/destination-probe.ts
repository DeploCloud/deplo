// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { gqlAction } from "@/lib/graphql-client";
import type { DestinationStatus } from "@/lib/types";

/** What a probe reports back per destination. */
export interface DestinationProbe {
  id: string;
  status: DestinationStatus;
  lastTestError: string | null;
  lastTestAt: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
}

/**
 * Don't re-probe if one finished this recently. Shared across every caller on the
 * page - a per-instance guard meant each picker, and the destinations tab, started
 * its own round.
 */
const PROBE_MIN_INTERVAL_MS = 30_000;

let lastProbeAt = 0;
let probeInFlight = false;

/**
 * Re-probe every destination in the active team. Resolves to null when the round
 * was skipped (too soon, one already running) or the call failed - a probe nobody
 * asked for is not the place to raise an error.
 */
export async function probeDestinations(): Promise<DestinationProbe[] | null> {
  if (probeInFlight) return null;
  if (Date.now() - lastProbeAt < PROBE_MIN_INTERVAL_MS) return null;
  probeInFlight = true;
  try {
    const res = await gqlAction<
      { testDestinations: DestinationProbe[] },
      DestinationProbe[]
    >(
      `mutation {
        testDestinations {
          id
          status
          lastTestError
          lastTestAt
          freeBytes
          totalBytes
        }
      }`,
      {},
      (d) => d.testDestinations,
    );
    return res.ok ? (res.data ?? null) : null;
  } finally {
    probeInFlight = false;
    lastProbeAt = Date.now();
  }
}
