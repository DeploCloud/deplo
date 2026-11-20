import type { City } from "./dbip";
import type { GeoPoint } from "./table";

// The cities the server location picker offers (ADR-0049), from the release's DB-IP database.

export type CityMatch = {
  name: string;
  region: string;
  country: string;
  label: string;
  latitude: number;
  longitude: number;
};

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

let regionNames: Intl.DisplayNames | null = null;

/** A country's name in English, from its ISO code; the code when the runtime does not know it. */
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function cityMatch(c: City): CityMatch {
  const [name, region, country, latitude, longitude] = c;
  const parts = [name, region !== name ? region : "", countryName(country)];
  return {
    name,
    region,
    country,
    label: parts.filter(Boolean).join(", "),
    latitude,
    longitude,
  };
}

/** The cities whose name, region or country hold every word typed; a city whose name starts with them comes first. */
export function searchCities(
  cities: City[],
  query: string,
  limit = 8,
): CityMatch[] {
  const words = fold(query)
    .split(/[\s,]+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const first: City[] = [];
  const rest: City[] = [];
  for (const c of cities) {
    const name = fold(c[0]);
    const all = `${name} ${fold(c[1])} ${fold(countryName(c[2]))} ${c[2].toLowerCase()}`;
    if (!words.every((w) => all.includes(w))) continue;
    (name.startsWith(words[0]) ? first : rest).push(c);
    if (first.length >= limit) break;
  }
  return [...first, ...rest].slice(0, limit).map(cityMatch);
}

const RAD = Math.PI / 180;

/** Great-circle distance in km. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** The biggest city near a point (the list is biggest first), to name where an address was placed. */
export function cityNear(
  cities: City[],
  at: GeoPoint,
  withinKm = 120,
): CityMatch | null {
  for (const c of cities)
    if (distanceKm(at, { lat: c[3], lon: c[4] }) <= withinKm)
      return cityMatch(c);
  return null;
}
