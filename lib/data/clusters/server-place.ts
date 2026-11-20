import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { placeRefusal } from "../../deploy/cluster-zone";
import { cityNear, searchCities, type CityMatch } from "../../geo/cities";
import { shippedGeo, type ShippedGeo } from "../../geo/shipped";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { requireClusterAdmin } from "./roster";

// Where each server of a cluster is (ADR-0049 phase 2): an admin picks a city, types coordinates, or Deplo places it by
// its own address. https://deplo.build/docs/operations/clusters/dns-zone

export type ServerPlace = {
  latitude: number;
  longitude: number;
  label: string;
  /** "city" or "coordinates" when an admin set it, "address" when the location table placed its address. */
  source: "city" | "coordinates" | "address";
};

type PlaceRow = {
  geoLatitude: number | null;
  geoLongitude: number | null;
  geoPlace: string | null;
};

const coords = (lat: number, lon: number) =>
  `${lat.toFixed(2)}, ${lon.toFixed(2)}`;

/** Where a server is: what an admin set, else where the release's table places its first public address. */
export function placeOf(
  row: PlaceRow,
  addresses: { v4: string[]; v6: string[] },
  geo: ShippedGeo,
): ServerPlace | null {
  if (row.geoLatitude != null && row.geoLongitude != null)
    return {
      latitude: row.geoLatitude,
      longitude: row.geoLongitude,
      label: row.geoPlace || coords(row.geoLatitude, row.geoLongitude),
      source: row.geoPlace ? "city" : "coordinates",
    };
  if (geo.state !== "ready") return null;
  for (const a of [...addresses.v4, ...addresses.v6]) {
    const at = geo.bundle.table.locate(a);
    if (!at) continue;
    return {
      latitude: at.lat,
      longitude: at.lon,
      label: cityNear(geo.bundle.cities, at)?.label ?? coords(at.lat, at.lon),
      source: "address",
    };
  }
  return null;
}

/** The place columns of some servers, by id. */
export async function placeRows(ids: string[]): Promise<Map<string, PlaceRow>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({
      id: serversTable.id,
      geoLatitude: serversTable.geoLatitude,
      geoLongitude: serversTable.geoLongitude,
      geoPlace: serversTable.geoPlace,
    })
    .from(serversTable)
    .where(inArray(serversTable.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The cities of the release's table that match what an admin typed. */
export async function findCities(query: string): Promise<CityMatch[]> {
  await requireClusterAdmin();
  const geo = await shippedGeo();
  if (geo.state !== "ready") return [];
  return searchCities(geo.bundle.cities, query.slice(0, 100));
}

const cleanLabel = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);

/**
 * Places a server: a city (its label and position), coordinates (no label), or null to let Deplo place it by its
 * address again. Its cluster's zone answers from the new place on the next pass.
 */
export async function setServerPlace(
  serverId: string,
  place: { latitude: number; longitude: number; label?: string | null } | null,
): Promise<string | null> {
  if (await instanceFrozen())
    throw new Error(
      "Deplo is moving to another machine; try again once it is done.",
    );
  const { teamId, user } = await requireClusterAdmin();
  const [server] = await getDb()
    .select({ id: serversTable.id, name: serversTable.name })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  if (!server) throw new Error("Server not found");
  let set: PlaceRow = { geoLatitude: null, geoLongitude: null, geoPlace: null };
  if (place) {
    const why = placeRefusal(place.latitude, place.longitude);
    if (why) throw new Error(why);
    set = {
      geoLatitude: place.latitude,
      geoLongitude: place.longitude,
      geoPlace: place.label ? cleanLabel(place.label) || null : null,
    };
  }
  await getDb()
    .update(serversTable)
    .set(set)
    .where(eq(serversTable.id, serverId));
  await recordActivity(
    "server",
    place
      ? `${server.name} is placed in ${set.geoPlace ?? coords(place.latitude, place.longitude)}`
      : `${server.name} is placed by its address again`,
    user.name,
    null,
    teamId,
  );
  const [member] = await getDb()
    .select({ clusterId: clusterMembers.clusterId })
    .from(clusterMembers)
    .where(eq(clusterMembers.serverId, serverId))
    .limit(1);
  return member?.clusterId ?? null;
}
