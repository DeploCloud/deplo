import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeGeoTable, GEO_NONE, GeoTable, ipv6ToBigInt } from "./table";

// ADR-0049 phase 2: the location table's format, as deplo-agent internal/dnszone/geo.go reads it.

const small = () =>
  encodeGeoTable({
    release: 20261101,
    places: [
      { lat: 45.46, lon: 9.19 },
      { lat: -33.87, lon: 151.21 },
    ],
    v4: [
      { start: 0, place: GEO_NONE },
      { start: 0xc6336400, place: 0 }, // 198.51.100.0
      { start: 0xc6336500, place: GEO_NONE },
    ],
    v6: [
      { start: BigInt(0), place: GEO_NONE },
      { start: BigInt("0x20010db800000000"), place: 1 },
      { start: BigInt("0x20010db900000000"), place: GEO_NONE },
    ],
  });

test("a table places an address, and says when it cannot", () => {
  const g = GeoTable.parse(small());
  assert.equal(g.release, 20261101);
  assert.match(g.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(g.locate("198.51.100.77"), { lat: 45.46, lon: 9.19 });
  assert.deepEqual(g.locate("::ffff:198.51.100.77"), { lat: 45.46, lon: 9.19 });
  assert.deepEqual(g.locate("2001:db8:ab::1"), { lat: -33.87, lon: 151.21 });
  for (const nowhere of [
    "198.51.101.0",
    "0.0.0.0",
    "255.255.255.255",
    "2001:db9::",
    "::",
    "not an address",
    "",
  ])
    assert.equal(g.locate(nowhere), null, nowhere);
});

test("a damaged table is refused, wherever the damage is", () => {
  const good = small();
  for (let i = 0; i < good.length; i++) {
    const bad = Buffer.from(good);
    bad[i] ^= 0x10;
    assert.throws(() => GeoTable.parse(bad), Error, `byte ${i}`);
  }
  assert.throws(() => GeoTable.parse(good.subarray(0, good.length - 1)));
  assert.throws(() => GeoTable.parse(Buffer.alloc(0)));
  // A table that is sealed but does not hold together is refused too.
  const unsorted = encodeGeoTable({
    release: 1,
    places: [],
    v4: [
      { start: 0, place: GEO_NONE },
      { start: 5, place: GEO_NONE },
      { start: 4, place: GEO_NONE },
    ],
    v6: [{ start: BigInt(0), place: GEO_NONE }],
  });
  assert.throws(() => GeoTable.parse(unsorted), /out of order/);
  const stranger = encodeGeoTable({
    release: 1,
    places: [],
    v4: [{ start: 0, place: 0 }],
    v6: [{ start: BigInt(0), place: GEO_NONE }],
  });
  assert.throws(() => GeoTable.parse(stranger), /names place/);
  const notFromZero = encodeGeoTable({
    release: 1,
    places: [],
    v4: [{ start: 1, place: GEO_NONE }],
    v6: [{ start: BigInt(0), place: GEO_NONE }],
  });
  assert.throws(() => GeoTable.parse(notFromZero), /first address/);
});

test("an IPv6 address reads as its 128 bits", () => {
  assert.equal(ipv6ToBigInt("::"), BigInt(0));
  assert.equal(ipv6ToBigInt("::1"), BigInt(1));
  assert.equal(
    ipv6ToBigInt("2001:db8::"),
    BigInt("0x20010db8000000000000000000000000"),
  );
  assert.equal(
    ipv6ToBigInt("2001:DB8:0:0:0:0:0:1"),
    BigInt("0x20010db8000000000000000000000001"),
  );
  assert.equal(ipv6ToBigInt("::ffff:1.2.3.4"), BigInt("0xffff01020304"));
  assert.equal(
    ipv6ToBigInt("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"),
    (BigInt(1) << BigInt(128)) - BigInt(1),
  );
});
