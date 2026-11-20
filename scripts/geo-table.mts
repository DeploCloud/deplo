// The release's location table (ADR-0049): DB-IP's "IP to City Lite" of the month, checked against the SHA-1 and the
// record count DB-IP publishes, then reduced. When that fails, the last good copy, from the newest release carrying one.
// Run by .github/workflows/docker-image.yml; `bun run geo:build` fills ./geo for a local run.
//
// usage: bun scripts/geo-table.mts <out dir> [--file <dbip-city-lite-YYYY-MM.csv.gz>]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";

import {
  checkGeoBundle,
  GEO_ATTRIBUTION,
  GEO_FILES,
  GEO_LICENCE,
  GEO_LICENCE_URL,
  GEO_SOURCE_URL,
  type GeoManifest,
} from "../lib/geo/bundle";
import { DbipReducer } from "../lib/geo/dbip";
import { ipv4ToNumber, ipv6ToBigInt } from "../lib/geo/table";

const PAGE = "https://db-ip.com/db/download/ip-to-city-lite";
const LINK =
  /^https:\/\/download\.db-ip\.com\/free\/dbip-city-lite-(\d{4})-(\d{2})\.csv\.gz$/;
const REPO = process.env.GITHUB_REPOSITORY || "DeploCloud/deplo";
// An address whose country has not moved in years: a file that misplaces it is not DB-IP's.
const SPOT = new Map([["8.8.8.8", "US"]]);
const MIN_RECORDS = 1_000_000;
const MIN_PLACED_V4 = 0.5;
const MIN_CITIES = 1000;

type Published = {
  url: string;
  release: string;
  sha1: string;
  records: number;
};

const say = (line: string) => console.log(line);
const warn = (line: string) =>
  console.log(
    process.env.GITHUB_ACTIONS ? `::warning::${line}` : `warning: ${line}`,
  );

/** The CSV file DB-IP offers now, with the SHA-1 of its contents and its record count, read off the download page. */
async function published(): Promise<Published> {
  const res = await fetch(PAGE, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${PAGE} answered ${res.status}`);
  const html = await res.text();
  const card = html
    .split(/<div class="card">/)
    .find((c) => /\.csv\.gz'/.test(c) && /SHA1SUM/.test(c));
  if (!card) throw new Error("the download page has no CSV card");
  const url = /href='([^']+\.csv\.gz)'/.exec(card)?.[1] ?? "";
  const m = LINK.exec(url);
  const sha1 = /SHA1SUM<\/dt>\s*<dd[^>]*>([0-9a-f]{40})<\/dd>/.exec(card)?.[1];
  const records = /Number of records<\/dt>\s*<dd>([\d,]+)<\/dd>/.exec(
    card,
  )?.[1];
  if (!m || !sha1 || !records)
    throw new Error(
      "the download page does not name the file, its SHA-1 and its record count",
    );
  return {
    url,
    release: `${m[1]}-${m[2]}`,
    sha1,
    records: Number(records.replace(/,/g, "")),
  };
}

/** Reduces one gzip'd CSV, checking it line by line, and its contents against what DB-IP published. */
async function reduce(gz: Readable, want: Published) {
  const [y, mo] = want.release.split("-").map(Number);
  const spot = [...SPOT].map(([addr, country]) => ({
    v6: addr.includes(":"),
    at: addr.includes(":") ? ipv6ToBigInt(addr) : BigInt(ipv4ToNumber(addr)),
    addr,
    country,
    seen: false,
  }));
  const reducer = new DbipReducer(y * 10000 + mo * 100 + 1, (r) => {
    for (const s of spot)
      if (s.v6 === r.v6 && r.start <= s.at && s.at <= r.end) {
        if (r.country !== s.country)
          throw new Error(
            `${s.addr} is placed in ${r.country}, not ${s.country}`,
          );
        s.seen = true;
      }
  });
  const sha1 = createHash("sha1");
  const plain = gz.pipe(createGunzip());
  plain.on("data", (chunk: Buffer) => sha1.update(chunk));
  for await (const line of createInterface({
    input: plain,
    crlfDelay: Infinity,
  }))
    reducer.push(line);
  const got = sha1.digest("hex");
  if (got !== want.sha1)
    throw new Error(`the file's SHA-1 is ${got}, DB-IP published ${want.sha1}`);
  const out = reducer.finish();
  if (out.records !== want.records || out.records < MIN_RECORDS)
    throw new Error(`${out.records} records, DB-IP published ${want.records}`);
  if (spot.some((s) => !s.seen))
    throw new Error("a well-known address is missing");
  if (out.placedV4 < MIN_PLACED_V4)
    throw new Error(
      `only ${(out.placedV4 * 100).toFixed(1)}% of IPv4 has a place`,
    );
  if (out.cities.length < MIN_CITIES)
    throw new Error(`only ${out.cities.length} cities`);
  return out;
}

async function writeBundle(
  out: string,
  want: Published,
  r: Awaited<ReturnType<typeof reduce>>,
) {
  const citiesRaw = Buffer.from(JSON.stringify(r.cities));
  const manifest: GeoManifest = {
    format: 1,
    source: "DB-IP IP to City Lite",
    release: want.release,
    attribution: GEO_ATTRIBUTION,
    url: GEO_SOURCE_URL,
    licence: GEO_LICENCE,
    licenceUrl: GEO_LICENCE_URL,
    sourceSha1: want.sha1,
    records: r.records,
    locations: {
      file: GEO_FILES.locations,
      sha256: createHash("sha256").update(r.table).digest("hex"),
      bytes: r.table.length,
    },
    cities: {
      file: GEO_FILES.cities,
      sha256: createHash("sha256").update(citiesRaw).digest("hex"),
      count: r.cities.length,
    },
    builtAt: new Date().toISOString(),
    reusedFrom: null,
  };
  const files = {
    manifest: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    locations: gzipSync(r.table, { level: 9 }),
    cities: gzipSync(citiesRaw, { level: 9 }),
  };
  // The bundle is checked as the panel will read it before anything is written.
  checkGeoBundle(files.manifest, files.locations, files.cities);
  await mkdir(out, { recursive: true });
  for (const k of ["manifest", "locations", "cities"] as const)
    await writeFile(join(out, GEO_FILES[k]), files[k]);
  say(
    `location table of ${want.release}: ${r.records} records, ${(r.placedV4 * 100).toFixed(1)}% of IPv4 placed, ` +
      `${(files.locations.length / 1e6).toFixed(1)} MB, ${r.cities.length} cities`,
  );
}

/** The last good copy: the geo-* assets of the newest release that carries them, checked like a fresh one. */
async function lastGoodCopy(out: string): Promise<string> {
  const tags = JSON.parse(
    execFileSync(
      "gh",
      [
        "release",
        "list",
        "--repo",
        REPO,
        "--limit",
        "40",
        "--json",
        "tagName,isDraft",
      ],
      {
        encoding: "utf8",
      },
    ),
  ) as { tagName: string; isDraft: boolean }[];
  for (const { tagName, isDraft } of tags) {
    if (isDraft) continue;
    const dir = await mkdtemp(join(tmpdir(), "deplo-geo-"));
    try {
      execFileSync(
        "gh",
        [
          "release",
          "download",
          tagName,
          "--repo",
          REPO,
          "--pattern",
          "geo-*",
          "--dir",
          dir,
        ],
        {
          stdio: "ignore",
        },
      );
    } catch {
      continue;
    }
    try {
      const read = (k: keyof typeof GEO_FILES) =>
        readFile(join(dir, `geo-${GEO_FILES[k]}`));
      const files = {
        manifest: await read("manifest"),
        locations: await read("locations"),
        cities: await read("cities"),
      };
      const b = checkGeoBundle(files.manifest, files.locations, files.cities);
      const manifest = {
        ...b.manifest,
        reusedFrom: b.manifest.reusedFrom ?? tagName,
      };
      await mkdir(out, { recursive: true });
      await writeFile(
        join(out, GEO_FILES.manifest),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await writeFile(join(out, GEO_FILES.locations), files.locations);
      await writeFile(join(out, GEO_FILES.cities), files.cities);
      return `${b.manifest.release} from ${tagName}`;
    } catch (e) {
      warn(`${tagName}'s location table is refused: ${(e as Error).message}`);
    }
  }
  throw new Error("no release carries a location table to reuse");
}

async function main() {
  const [out, flag, file] = process.argv.slice(2);
  if (!out)
    throw new Error(
      "usage: bun scripts/geo-table.mts <out dir> [--file <csv.gz>]",
    );
  try {
    const want = await published();
    say(
      `DB-IP publishes ${want.url} (${want.records} records, SHA-1 ${want.sha1})`,
    );
    let source: Readable;
    if (flag === "--file" && file) source = createReadStream(file);
    else {
      const res = await fetch(want.url, {
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!res.ok || !res.body)
        throw new Error(`${want.url} answered ${res.status}`);
      source = Readable.fromWeb(res.body as never);
    }
    await writeBundle(out, want, await reduce(source, want));
  } catch (e) {
    warn(
      `DB-IP's database could not be used (${(e as Error).message}); reusing the last good copy`,
    );
    const reused = await lastGoodCopy(out);
    warn(`this release ships the location table of ${reused}`);
  }
}

main().catch((e) => {
  console.error(`::error::${(e as Error).message}`);
  process.exit(1);
});
