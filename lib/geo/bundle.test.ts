import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { checkGeoBundle, readGeoBundle } from "./bundle";
import { geoBundleFiles, writeGeoBundle } from "./geo-test-helpers";

// ADR-0049 phase 2: what a release ships of DB-IP's database, checked whole before Deplo uses any of it.

test("a release's bundle is read whole", async () => {
  const f = geoBundleFiles();
  const b = checkGeoBundle(f.manifest, f.locations, f.cities);
  assert.equal(b.manifest.release, "2026-11");
  assert.equal(b.cities.length, 1);
  assert.deepEqual(b.table.locate("198.51.100.1"), { lat: 45, lon: 9 });
  const dir = mkdtempSync(join(tmpdir(), "geo-"));
  assert.equal(
    await readGeoBundle(dir),
    null,
    "no bundle in an empty directory",
  );
  writeGeoBundle(dir, f);
  assert.equal((await readGeoBundle(dir))?.table.digest, b.table.digest);
});

test("a bundle whose files do not match its manifest is refused", () => {
  const f = geoBundleFiles();
  const other = geoBundleFiles({ release: "2026-10" });
  const damaged = Buffer.from(f.locations);
  damaged[damaged.length - 12] ^= 1;
  const cases: Record<string, [Buffer, Buffer, Buffer]> = {
    "a damaged table": [f.manifest, damaged, f.cities],
    "another release": [other.manifest, f.locations, f.cities],
    "a table it does not name": [
      geoBundleFiles({
        locations: { file: "x", sha256: "0".repeat(64), bytes: 1 },
      }).manifest,
      f.locations,
      f.cities,
    ],
    "cities it does not name": [
      f.manifest,
      f.locations,
      gzipSync(Buffer.from("[]")),
    ],
    "a manifest that is not JSON": [Buffer.from("{"), f.locations, f.cities],
    "not gzip": [f.manifest, Buffer.from("nope"), f.cities],
  };
  for (const [what, [m, l, c]] of Object.entries(cases))
    assert.throws(() => checkGeoBundle(m, l, c), Error, what);
});
