import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { City } from "./dbip";
import { GeoTable, MAX_GEO_BYTES } from "./table";

// What a release ships of DB-IP's database (ADR-0049): the reduced table, the picker's cities and a manifest that names
// both by digest. https://deplo.build/docs/operations/clusters/dns-zone

export const GEO_ATTRIBUTION = "IP geolocation by DB-IP";
export const GEO_SOURCE_URL = "https://db-ip.com";
export const GEO_LICENCE = "CC BY 4.0";
export const GEO_LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/";

export const GEO_FILES = {
  manifest: "manifest.json",
  locations: "locations.bin.gz",
  cities: "cities.json.gz",
} as const;

export type GeoManifest = {
  format: 1;
  source: string;
  /** DB-IP's release, "2026-11". */
  release: string;
  attribution: string;
  url: string;
  licence: string;
  licenceUrl: string;
  sourceSha1: string;
  records: number;
  locations: { file: string; sha256: string; bytes: number };
  cities: { file: string; sha256: string; count: number };
  builtAt: string;
  /** The release whose copy this one reuses because DB-IP's download failed; null for a fresh one. */
  reusedFrom: string | null;
};

export type GeoBundle = {
  manifest: GeoManifest;
  table: GeoTable;
  /** The table as handed to server agents. */
  tableGz: Buffer;
  cities: City[];
};

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function gunzipBounded(gz: Buffer, what: string): Buffer {
  try {
    return gunzipSync(gz, { maxOutputLength: MAX_GEO_BYTES });
  } catch (e) {
    throw new Error(`${what} does not unpack: ${(e as Error).message}`);
  }
}

/** A bundle from its three files, each checked against the manifest; throws on anything that does not match. */
export function checkGeoBundle(
  manifestRaw: Buffer,
  locationsGz: Buffer,
  citiesGz: Buffer,
): GeoBundle {
  let manifest: GeoManifest;
  try {
    manifest = JSON.parse(manifestRaw.toString("utf8")) as GeoManifest;
  } catch {
    throw new Error("The location table's manifest is not JSON.");
  }
  if (manifest.format !== 1 || !/^\d{4}-\d{2}$/.test(manifest.release))
    throw new Error("The location table's manifest is not one Deplo reads.");
  const raw = gunzipBounded(locationsGz, "The location table");
  if (sha256(raw) !== manifest.locations.sha256)
    throw new Error("The location table is not the one its manifest names.");
  const table = GeoTable.parse(raw);
  const release = `${Math.floor(table.release / 10000)}-${String(Math.floor(table.release / 100) % 100).padStart(2, "0")}`;
  if (release !== manifest.release)
    throw new Error(
      `The location table is of ${release}, its manifest says ${manifest.release}.`,
    );
  const citiesRaw = gunzipBounded(citiesGz, "The city list");
  if (sha256(citiesRaw) !== manifest.cities.sha256)
    throw new Error("The city list is not the one its manifest names.");
  const cities = JSON.parse(citiesRaw.toString("utf8")) as City[];
  if (
    !Array.isArray(cities) ||
    cities.length !== manifest.cities.count ||
    !cities.every(
      (c) =>
        Array.isArray(c) &&
        c.length === 5 &&
        typeof c[0] === "string" &&
        Math.abs(c[3]) <= 90 &&
        Math.abs(c[4]) <= 180,
    )
  )
    throw new Error("The city list does not hold together.");
  return { manifest, table, tableGz: locationsGz, cities };
}

/** Reads and checks the bundle in dir; null when the directory holds none. */
export async function readGeoBundle(dir: string): Promise<GeoBundle | null> {
  let manifestRaw: Buffer;
  try {
    manifestRaw = await readFile(join(dir, GEO_FILES.manifest));
  } catch {
    return null;
  }
  const [locationsGz, citiesGz] = await Promise.all([
    readFile(join(dir, GEO_FILES.locations)),
    readFile(join(dir, GEO_FILES.cities)),
  ]);
  return checkGeoBundle(manifestRaw, locationsGz, citiesGz);
}
