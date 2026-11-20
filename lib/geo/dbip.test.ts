import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DbipReducer, splitCsvLine } from "./dbip";
import { GeoTable } from "./table";

// ADR-0049 phase 2: DB-IP's CSV reduced to the table the server agents read, refused when it does not hold together.

const DIR = join(process.cwd(), "lib", "geo");
const FIXTURE = readFileSync(join(DIR, "dbip-fixture.csv"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean);
const GOLDEN = join(DIR, "geo-table.golden.bin");
const LOOKUPS = join(DIR, "geo-lookups.golden.json");

function reduce(lines: string[]) {
  const r = new DbipReducer(20261101);
  for (const l of lines) r.push(l);
  return r.finish();
}

const MILAN = [45, 9];
const ROME = [42, 12];
const TOKYO = [36, 140];
const NEW_YORK = [41, -74];

// Where each address of the fixture lands: blocks of /22 and /40, each at the place covering most of it.
const EXPECTED: [string, number[] | null][] = [
  ["100.1.2.3", TOKYO],
  ["198.51.100.1", MILAN],
  ["198.51.103.200", MILAN], // Rome's /24 is outweighed in its /22
  ["198.51.104.5", MILAN], // a tie between Milan and Rome: the place read first
  ["198.51.109.1", ROME],
  ["203.0.113.1", NEW_YORK],
  ["203.0.117.1", NEW_YORK],
  ["203.0.120.5", null], // ten addresses of Newark in a /22 of nowhere
  ["10.0.0.53", null],
  ["8.8.8.8", null],
  ["255.255.255.255", null],
  ["::ffff:198.51.100.1", MILAN],
  ["2001:db8::1", TOKYO],
  ["2001:db8:ff:1::1", TOKYO],
  ["2001:db8:1a0::1", MILAN],
  ["2001:db8:200::1", null],
  ["::1", null],
  ["ffff::1", null],
];

// The agent reads the same two files (deplo-agent internal/dnszone/testdata) and must place each address the same.
test("the fixture reduces to the reference table the agent reads", () => {
  const { table, records } = reduce(FIXTURE);
  assert.equal(records, FIXTURE.length);
  const lookups = EXPECTED.map(([address, at]) => ({ address, at }));
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(GOLDEN, table);
    writeFileSync(LOOKUPS, `${JSON.stringify(lookups, null, 2)}\n`);
  }
  assert.ok(
    readFileSync(GOLDEN).equals(table),
    "the table differs from geo-table.golden.bin",
  );
  assert.deepEqual(JSON.parse(readFileSync(LOOKUPS, "utf8")), lookups);
  const g = GeoTable.parse(table);
  assert.equal(g.release, 20261101);
  for (const [address, at] of EXPECTED) {
    const got = g.locate(address);
    assert.deepEqual(got && [got.lat, got.lon], at, address);
  }
});

test("a city's districts count as the city, and only a city of some size is offered", () => {
  const { cities } = reduce(FIXTURE);
  assert.deepEqual(cities, [["Tokyo", "Tokyo", "JP", 35.69, 139.69]]);
});

test("a file that does not hold together is refused", () => {
  const replace = (i: number, line: string) =>
    FIXTURE.map((l, j) => (j === i ? line : l));
  const bad: Record<string, string[]> = {
    "a gap": replace(1, "10.0.0.1,10.255.255.255,ZZ,ZZ,,,0,0"),
    "an overlap": replace(1, "9.0.0.0,10.255.255.255,ZZ,ZZ,,,0,0"),
    "a range backwards": replace(1, "10.0.0.0,9.255.255.255,ZZ,ZZ,,,0,0"),
    "seven fields": replace(
      5,
      "198.51.100.0,198.51.102.255,EU,IT,Milan,45.46,9.18",
    ),
    "a latitude off the globe": replace(
      5,
      "198.51.100.0,198.51.102.255,EU,IT,Lombardy,Milan,91,9.18",
    ),
    "no latitude": replace(
      5,
      "198.51.100.0,198.51.102.255,EU,IT,Lombardy,Milan,,9.18",
    ),
    "not a country": replace(
      5,
      "198.51.100.0,198.51.102.255,EU,it,Lombardy,Milan,45,9",
    ),
    "not an address": replace(
      5,
      "198.51.100.0,198.51.102.x,EU,IT,Lombardy,Milan,45,9",
    ),
    "a family mixed": replace(
      5,
      "198.51.100.0,2001:db8::,EU,IT,Lombardy,Milan,45,9",
    ),
    "IPv4 cut short": FIXTURE.filter((_, i) => i !== 14),
    "IPv6 cut short": FIXTURE.slice(0, -1),
    "IPv4 after IPv6": [...FIXTURE.slice(0, 15), FIXTURE[15], FIXTURE[14]],
  };
  for (const [what, lines] of Object.entries(bad))
    assert.throws(() => reduce(lines), Error, what);
});

test("a CSV line is read as RFC 4180 writes it", () => {
  assert.deepEqual(
    splitCsvLine(
      '1.0.0.0,1.0.0.255,OC,AU,Queensland,"South Brisbane",-27.47,153.01',
    ),
    [
      "1.0.0.0",
      "1.0.0.255",
      "OC",
      "AU",
      "Queensland",
      "South Brisbane",
      "-27.47",
      "153.01",
    ],
  );
  assert.deepEqual(splitCsvLine('a,"b, ""c""",'), ["a", 'b, "c"', ""]);
});
