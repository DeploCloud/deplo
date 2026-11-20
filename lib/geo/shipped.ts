import "server-only";

import { join } from "node:path";

import { messageOf } from "../utils";
import { readGeoBundle, type GeoBundle } from "./bundle";

// The location table this release carries (ADR-0049), read once and checked whole; never fetched from anywhere.

/** Past this many months the cluster's DNS settings say the table is old. */
export const GEO_STALE_MONTHS = 3;

export type ShippedGeo =
  | { state: "missing" }
  | { state: "damaged"; problem: string }
  | { state: "ready"; bundle: GeoBundle };

let loading: Promise<ShippedGeo> | null = null;

function geoDir(): string {
  return process.env.DEPLO_GEO_DIR || join(process.cwd(), "geo");
}

/** The release's table and cities, or why there are none. */
export function shippedGeo(): Promise<ShippedGeo> {
  loading ??= readGeoBundle(geoDir()).then(
    (bundle): ShippedGeo =>
      bundle ? { state: "ready", bundle } : { state: "missing" },
    (e): ShippedGeo => {
      console.warn(`[geo] the location table is refused: ${messageOf(e)}`);
      return { state: "damaged", problem: messageOf(e) };
    },
  );
  return loading;
}

/** Reads the directory again on the next call; for tests. */
export function __resetShippedGeoForTest(): void {
  loading = null;
}

/** Whole months from DB-IP's release ("2026-11") to now. */
export function geoAgeMonths(release: string, now = new Date()): number {
  const [y, m] = release.split("-").map(Number);
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
}
