/** Whether `hostname` is the zone itself or a name under it. */
export function zoneCovers(zone: string, hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === zone || host.endsWith(`.${zone}`);
}

/** The most specific of `zones` that covers `hostname`, or null. */
export function coveringZone(
  zones: readonly string[],
  hostname: string,
): string | null {
  return (
    zones
      .filter((z) => zoneCovers(z, hostname))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}
