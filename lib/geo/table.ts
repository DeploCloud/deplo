import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

// The location table (ADR-0049 phase 2): where an address is, roughly. The release builds it from DB-IP's
// "IP to City Lite" (lib/geo/dbip.ts) and Deplo hands it to each server agent, whose name server reads the same
// format (deplo-agent internal/dnszone/geo.go). The layout is described there.

export const GEO_MAGIC = "DEPLOGEO";
const VERSION = 1;
const HEADER = 32;
const DIGEST = 32;
export const GEO_NONE = 0xffff;
const MAX_PLACES = GEO_NONE;
const MAX_BLOCKS = 8 << 20;
export const MAX_GEO_BYTES = 64 << 20;

export type GeoPoint = { lat: number; lon: number };

export type GeoTableInput = {
  /** DB-IP's release, YYYYMMDD. */
  release: number;
  /** In degrees; kept to hundredths. */
  places: GeoPoint[];
  v4: { start: number; place: number }[];
  /** The first 64 bits of each IPv6 block's start. */
  v6: { start: bigint; place: number }[];
};

/** The bytes of a table; places are rounded to hundredths of a degree. */
export function encodeGeoTable(t: GeoTableInput): Buffer {
  const size =
    HEADER + 4 * t.places.length + 6 * t.v4.length + 10 * t.v6.length;
  const b = Buffer.alloc(size + DIGEST);
  b.write(GEO_MAGIC, 0, "latin1");
  b.writeUInt16LE(VERSION, 8);
  b.writeUInt32LE(t.release, 12);
  b.writeUInt32LE(t.places.length, 16);
  b.writeUInt32LE(t.v4.length, 20);
  b.writeUInt32LE(t.v6.length, 24);
  let off = HEADER;
  for (const p of t.places) {
    b.writeInt16LE(Math.round(p.lat * 100), off);
    b.writeInt16LE(Math.round(p.lon * 100), off + 2);
    off += 4;
  }
  for (const k of t.v4) off = b.writeUInt32LE(k.start, off);
  for (const k of t.v4) off = b.writeUInt16LE(k.place, off);
  for (const k of t.v6) off = b.writeBigUInt64LE(k.start, off);
  for (const k of t.v6) off = b.writeUInt16LE(k.place, off);
  createHash("sha256").update(b.subarray(0, size)).digest().copy(b, size);
  return b;
}

export class GeoTable {
  private constructor(
    /** DB-IP's release, YYYYMMDD. */
    readonly release: number,
    /** The hex SHA-256 the table carries, which names it. */
    readonly digest: string,
    private readonly places: GeoPoint[],
    private readonly v4: Uint32Array,
    private readonly v4p: Uint16Array,
    private readonly v6: BigUint64Array,
    private readonly v6p: Uint16Array,
  ) {}

  /** Checks a table whole, its digest included; throws on one that does not hold together. */
  static parse(raw: Buffer): GeoTable {
    if (raw.length > MAX_GEO_BYTES)
      throw new Error(`A location table of ${raw.length} bytes.`);
    if (
      raw.length < HEADER + DIGEST ||
      raw.toString("latin1", 0, 8) !== GEO_MAGIC
    )
      throw new Error("Not a location table.");
    const body = raw.subarray(0, raw.length - DIGEST);
    const sum = raw.subarray(raw.length - DIGEST);
    if (!createHash("sha256").update(body).digest().equals(sum))
      throw new Error(
        "The location table is damaged: its digest does not match.",
      );
    const version = raw.readUInt16LE(8);
    if (version !== VERSION)
      throw new Error(`A location table of version ${version}.`);
    const p = raw.readUInt32LE(16);
    const n4 = raw.readUInt32LE(20);
    const n6 = raw.readUInt32LE(24);
    if (
      p > MAX_PLACES ||
      n4 < 1 ||
      n4 > MAX_BLOCKS ||
      n6 < 1 ||
      n6 > MAX_BLOCKS
    )
      throw new Error(
        `A location table of ${p} places, ${n4} and ${n6} blocks.`,
      );
    if (body.length !== HEADER + 4 * p + 6 * n4 + 10 * n6)
      throw new Error("The location table is not the size it says.");
    let off = HEADER;
    const places: GeoPoint[] = [];
    for (let i = 0; i < p; i++, off += 4) {
      const lat = raw.readInt16LE(off);
      const lon = raw.readInt16LE(off + 2);
      if (lat < -9000 || lat > 9000 || lon < -18000 || lon > 18000)
        throw new Error(`Place ${i} is off the globe.`);
      places.push({ lat: lat / 100, lon: lon / 100 });
    }
    const v4 = new Uint32Array(n4);
    for (let i = 0; i < n4; i++, off += 4) v4[i] = raw.readUInt32LE(off);
    const v4p = new Uint16Array(n4);
    for (let i = 0; i < n4; i++, off += 2) v4p[i] = raw.readUInt16LE(off);
    const v6 = new BigUint64Array(n6);
    for (let i = 0; i < n6; i++, off += 8) v6[i] = raw.readBigUInt64LE(off);
    const v6p = new Uint16Array(n6);
    for (let i = 0; i < n6; i++, off += 2) v6p[i] = raw.readUInt16LE(off);
    if (v4[0] !== 0 || v6[0] !== BigInt(0))
      throw new Error(
        "The location table does not start at the first address.",
      );
    for (let i = 1; i < n4; i++)
      if (v4[i] <= v4[i - 1])
        throw new Error(`IPv4 block ${i} is out of order.`);
    for (let i = 1; i < n6; i++)
      if (v6[i] <= v6[i - 1])
        throw new Error(`IPv6 block ${i} is out of order.`);
    for (const list of [v4p, v6p])
      for (let i = 0; i < list.length; i++)
        if (list[i] !== GEO_NONE && list[i] >= p)
          throw new Error(`Block ${i} names place ${list[i]} of ${p}.`);
    return new GeoTable(
      raw.readUInt32LE(12),
      sum.toString("hex"),
      places,
      v4,
      v4p,
      v6,
      v6p,
    );
  }

  /** Where an address is, or null when the table has no place for it (or it is not an address). */
  locate(address: string): GeoPoint | null {
    const a = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
    let at: number;
    if (isIPv4(a)) {
      const k = ipv4ToNumber(a);
      at = this.v4p[lastAtOrBelow(this.v4, k) as number];
    } else if (isIPv6(a)) {
      const k = ipv6ToBigInt(a) >> BigInt(64);
      at = this.v6p[lastAtOrBelow(this.v6, k) as number];
    } else return null;
    return at === GEO_NONE ? null : this.places[at];
  }
}

function lastAtOrBelow<T extends number | bigint>(
  list: { length: number; [i: number]: T },
  k: T,
): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] > k) hi = mid;
    else lo = mid + 1;
  }
  return lo - 1;
}

export function ipv4ToNumber(a: string): number {
  return a.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

/** An IPv6 address as a 128-bit number; an embedded IPv4 tail is read too. */
export function ipv6ToBigInt(a: string): bigint {
  let s = a.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = ipv4ToNumber(v4[1]);
    s = `${s.slice(0, v4.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const parts =
    tail === undefined
      ? h
      : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return parts.reduce(
    (n, part) => (n << BigInt(16)) | BigInt(parseInt(part || "0", 16)),
    BigInt(0),
  );
}
