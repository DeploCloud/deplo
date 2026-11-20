import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { GEO_FILES, type GeoManifest } from "./bundle";
import { DbipReducer } from "./dbip";

// A release's location bundle built from lib/geo/dbip-fixture.csv, for tests.

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The three files of a bundle, from the fixture; overrides change the manifest. */
export function geoBundleFiles(overrides: Partial<GeoManifest> = {}) {
  const r = new DbipReducer(20261101);
  for (const l of readFileSync(
    join(process.cwd(), "lib", "geo", "dbip-fixture.csv"),
    "utf8",
  ).split(/\r?\n/))
    r.push(l);
  const { table, cities } = r.finish();
  const citiesRaw = Buffer.from(JSON.stringify(cities));
  const manifest: GeoManifest = {
    format: 1,
    source: "DB-IP IP to City Lite",
    release: "2026-11",
    attribution: "IP geolocation by DB-IP",
    url: "https://db-ip.com",
    licence: "CC BY 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    sourceSha1: "0".repeat(40),
    records: 20,
    locations: {
      file: GEO_FILES.locations,
      sha256: sha256(table),
      bytes: table.length,
    },
    cities: {
      file: GEO_FILES.cities,
      sha256: sha256(citiesRaw),
      count: cities.length,
    },
    builtAt: "2026-11-20T00:00:00.000Z",
    reusedFrom: null,
    ...overrides,
  };
  return {
    manifest: Buffer.from(JSON.stringify(manifest)),
    locations: gzipSync(table),
    cities: gzipSync(citiesRaw),
  };
}

/** Writes a bundle's files into dir, as a release lays them out. */
export function writeGeoBundle(
  dir: string,
  f: ReturnType<typeof geoBundleFiles>,
): void {
  writeFileSync(join(dir, GEO_FILES.manifest), f.manifest);
  writeFileSync(join(dir, GEO_FILES.locations), f.locations);
  writeFileSync(join(dir, GEO_FILES.cities), f.cities);
}
