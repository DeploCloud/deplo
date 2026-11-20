import { isIPv4, isIPv6 } from "node:net";

import {
  encodeGeoTable,
  GEO_NONE,
  ipv4ToNumber,
  ipv6ToBigInt,
  type GeoPoint,
} from "./table";

// DB-IP "IP to City Lite" (CC BY 4.0, https://db-ip.com), reduced to what placing a visitor needs (ADR-0049):
// IPv4 in /22 blocks and IPv6 in /40 blocks, each at the whole-degree place that covers most of it.

export const V4_BLOCK_BITS = 22;
export const V6_BLOCK_BITS = 40;
/** The cities the picker offers: every one with at least this many IPv4 addresses, the biggest first. */
export const CITY_MIN_ADDRESSES = 4096;
export const MAX_CITIES = 25_000;

/** A city of the picker: name, region, country code, latitude, longitude. */
export type City = [string, string, string, number, number];

const ZERO = BigInt(0);
const ONE = BigInt(1);
const V4_END = 2 ** 32;
const V6_END = ONE << BigInt(128);

/** One CSV line, RFC 4180: commas, and double quotes around a field that holds one. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c !== '"') cur += c;
      else if (line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Blocks of one address family, each at the place that covers most of it; a run of equal blocks is one entry. */
class Blocks {
  readonly out: { start: bigint; place: number }[] = [];
  private pending: { block: bigint; weights: Map<number, bigint> } | null =
    null;

  constructor(private readonly size: bigint) {}

  /** Every address from s to e (inclusive) is at place. */
  cover(s: bigint, e: bigint, place: number) {
    const size = this.size;
    let pos = s;
    while (pos <= e) {
      const block = pos / size;
      const blockStart = block * size;
      const blockEnd = (block + ONE) * size - ONE;
      if (pos === blockStart && e >= blockEnd) {
        // Whole blocks, up to the last one the range covers to its end.
        this.flush();
        this.emit(block, place);
        pos = ((e + ONE) / size) * size;
        continue;
      }
      const segEnd = e < blockEnd ? e : blockEnd;
      if (this.pending && this.pending.block !== block) this.flush();
      if (!this.pending) this.pending = { block, weights: new Map() };
      const w = this.pending.weights;
      w.set(place, (w.get(place) ?? ZERO) + segEnd - pos + ONE);
      pos = segEnd + ONE;
      if (segEnd === blockEnd) this.flush();
    }
  }

  private emit(block: bigint, place: number) {
    const last = this.out[this.out.length - 1];
    if (last && last.place === place) return;
    this.out.push({ start: block * this.size, place });
  }

  /** The block in progress takes the place that covers most of it; a tie goes to the smaller place number. */
  flush() {
    if (!this.pending) return;
    let best = GEO_NONE;
    let most = -ONE;
    for (const [place, w] of this.pending.weights)
      if (w > most || (w === most && place < best)) {
        best = place;
        most = w;
      }
    this.emit(this.pending.block, best);
    this.pending = null;
  }
}

export type DbipSummary = {
  records: number;
  table: Buffer;
  cities: City[];
  /** Share of IPv4 addresses with a place. */
  placedV4: number;
};

/**
 * Reads DB-IP's CSV line by line and refuses a file that does not hold together: every range in order, no gap,
 * IPv4 then IPv6, each family covered to its last address, every place on the globe.
 */
export class DbipReducer {
  private records = 0;
  private v4Next = 0;
  private v6Next = ZERO;
  private inV6 = false;
  private placedV4 = 0;
  private readonly placeIndex = new Map<string, number>();
  private readonly places: GeoPoint[] = [];
  private readonly v4 = new Blocks(ONE << BigInt(32 - V4_BLOCK_BITS));
  private readonly v6 = new Blocks(ONE << BigInt(128 - V6_BLOCK_BITS));
  private readonly cities = new Map<
    string,
    {
      name: string;
      region: string;
      country: string;
      count: number;
      best: number;
      lat: number;
      lon: number;
    }
  >();

  constructor(
    private readonly release: number,
    /** Sees every range as it is read, to check what a file must say. */
    private readonly inspect?: (range: {
      start: bigint;
      end: bigint;
      v6: boolean;
      country: string;
    }) => void,
  ) {}

  push(line: string): void {
    if (line === "") return;
    this.records++;
    const at = `line ${this.records}`;
    const f = splitCsvLine(line);
    if (f.length !== 8) throw new Error(`${at}: ${f.length} fields, not 8.`);
    const [start, end, , country, region, city, rawLat, rawLon] = f;
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (
      !/^[A-Z]{2}$/.test(country) ||
      rawLat === "" ||
      rawLon === "" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      throw new Error(`${at}: not a place.`);
    const place = country === "ZZ" ? GEO_NONE : this.placeOf(lat, lon);
    if (isIPv4(start) && isIPv4(end)) {
      if (this.inV6) throw new Error(`${at}: IPv4 after IPv6.`);
      const s = ipv4ToNumber(start);
      const e = ipv4ToNumber(end);
      if (s !== this.v4Next || e < s)
        throw new Error(`${at}: ${start} does not follow the range before it.`);
      this.v4Next = e + 1;
      this.v4.cover(BigInt(s), BigInt(e), place);
      this.inspect?.({ start: BigInt(s), end: BigInt(e), v6: false, country });
      if (place !== GEO_NONE) {
        this.placedV4 += e - s + 1;
        // "Frankfurt am Main (Innenstadt I)" is a district of the city the picker offers.
        const name = city.replace(/\s*\([^)]*\)\s*$/, "").trim();
        if (name) this.countCity(name, region, country, e - s + 1, lat, lon);
      }
    } else if (isIPv6(start) && isIPv6(end)) {
      if (!this.inV6) {
        if (this.v4Next !== V4_END)
          throw new Error(`${at}: IPv6 before IPv4 reached its last address.`);
        this.v4.flush();
        this.inV6 = true;
      }
      const s = ipv6ToBigInt(start);
      const e = ipv6ToBigInt(end);
      if (s !== this.v6Next || e < s)
        throw new Error(`${at}: ${start} does not follow the range before it.`);
      this.v6Next = e + ONE;
      this.v6.cover(s, e, place);
      this.inspect?.({ start: s, end: e, v6: true, country });
    } else throw new Error(`${at}: not a range of addresses.`);
  }

  private placeOf(lat: number, lon: number): number {
    const key = `${Math.round(lat)},${Math.round(lon)}`;
    let i = this.placeIndex.get(key);
    if (i === undefined) {
      i = this.places.length;
      if (i >= GEO_NONE) throw new Error("Too many places.");
      this.placeIndex.set(key, i);
      this.places.push({ lat: Math.round(lat), lon: Math.round(lon) });
    }
    return i;
  }

  private countCity(
    name: string,
    region: string,
    country: string,
    count: number,
    lat: number,
    lon: number,
  ) {
    const key = `${country}\u0000${region}\u0000${name}`;
    const c = this.cities.get(key);
    if (!c) {
      this.cities.set(key, {
        name,
        region,
        country,
        count,
        best: count,
        lat,
        lon,
      });
      return;
    }
    c.count += count;
    // A city's place is that of its largest range.
    if (count > c.best) {
      c.best = count;
      c.lat = lat;
      c.lon = lon;
    }
  }

  finish(): DbipSummary {
    if (this.v4Next !== V4_END)
      throw new Error("IPv4 stops short of its last address.");
    if (this.v6Next !== V6_END)
      throw new Error("IPv6 stops short of its last address.");
    this.v6.flush();
    const round = (n: number) => Math.round(n * 100) / 100;
    const cities = [...this.cities.values()]
      .filter((c) => c.count >= CITY_MIN_ADDRESSES)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, MAX_CITIES)
      .map((c): City => [
        c.name,
        c.region,
        c.country,
        round(c.lat),
        round(c.lon),
      ]);
    const table = encodeGeoTable({
      release: this.release,
      places: this.places,
      v4: this.v4.out.map((b) => ({ start: Number(b.start), place: b.place })),
      v6: this.v6.out.map((b) => ({
        start: b.start >> BigInt(64),
        place: b.place,
      })),
    });
    return {
      records: this.records,
      table,
      cities,
      placedV4: this.placedV4 / V4_END,
    };
  }
}
