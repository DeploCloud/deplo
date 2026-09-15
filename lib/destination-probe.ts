import { gqlAction } from "@/lib/graphql-client";
import type { DestinationStatus } from "@/lib/types/backup";

export interface DestinationProbe {
  id: string;
  status: DestinationStatus;
  lastTestError: string | null;
  lastTestAt: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
}

const PROBE_MIN_INTERVAL_MS = 30_000;

let lastProbeAt = 0;
let probeInFlight = false;

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
