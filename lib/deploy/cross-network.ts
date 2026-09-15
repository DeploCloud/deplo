export type OutOfReach = "elsewhere" | "other-host";

export interface Neighbour {
  name: string;
  network: string;
  where: string;
  why: OutOfReach | "reachable";
}

export interface ForeignName {
  name: string;
  network: string;
  where: string;
  why: OutOfReach;
}

export interface CrossNetworkRef {
  key: string;
  name: string;
  where: string;
  why: OutOfReach;
}

const HOST_KEY =
  /(HOSTNAME|HOST|ADDR|ADDRESS|SERVER|ENDPOINT|UPSTREAM|TARGET)S?$/i;

/**
 * ponytail: a heuristic, deliberately. It reads a URL authority or a `host:port`,
 * and otherwise trusts a bare value only when the KEY says host - which is what
 * separates `DB_HOST=garage` from `S3_REGION=garage`. Widen it with a measured
 * false negative, never with a guess.
 */
export function usesAsHost(key: string, value: string, name: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const n = name.toLowerCase();
  const authority = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]*@)?([^/:?#\s]+)/i.exec(
    v,
  );
  if (authority && authority[1].toLowerCase() === n) return true;
  const hostPort = /^([a-z0-9][a-z0-9._-]*):\d+$/i.exec(v);
  if (hostPort && hostPort[1].toLowerCase() === n) return true;
  return v.toLowerCase() === n && HOST_KEY.test(key);
}

export function crossNetworkRefs(
  env: Record<string, string>,
  foreign: ForeignName[],
): CrossNetworkRef[] {
  const out: CrossNetworkRef[] = [];
  const seen = new Set<string>();
  for (const f of foreign) {
    for (const [key, value] of Object.entries(env)) {
      if (!usesAsHost(key, value, f.name)) continue;
      if (seen.has(f.name)) break;
      seen.add(f.name);
      out.push({ key, name: f.name, where: f.where, why: f.why });
      break;
    }
  }
  return out;
}

export function crossNetworkMessage(ref: CrossNetworkRef): string {
  if (ref.why === "other-host") {
    return (
      `${ref.key} points at \`${ref.name}\`, which is in ${ref.where} with this ` +
      `app but runs on ANOTHER SERVER. A network only spans one machine, so the ` +
      `name will not resolve. Put both on the same server, or publish a port and ` +
      `use the server's address.`
    );
  }
  return (
    `${ref.key} points at \`${ref.name}\`, which lives in ${ref.where} and is ` +
    `not reachable from here. Move this app into the same environment, or use a ` +
    `managed database placed there.`
  );
}

export interface NameClash {
  name: string;
  where: string;
}

export function nameClashes(
  mine: string[],
  neighbours: Neighbour[],
): NameClash[] {
  const claimed = new Set(mine.map((n) => n.toLowerCase()));
  const out: NameClash[] = [];
  const seen = new Set<string>();
  for (const n of neighbours) {
    if (n.why !== "reachable" || !claimed.has(n.name) || seen.has(n.name))
      continue;
    seen.add(n.name);
    out.push({ name: n.name, where: n.where });
  }
  return out;
}

export function nameClashMessage(clash: NameClash): string {
  return (
    `\`${clash.name}\` is also answered by a stack in ${clash.where}, on the same ` +
    `network as this one. Docker splits the lookups between them, so half will reach ` +
    `the wrong container. Rename the service, or its \`hostname:\`.`
  );
}

export function hostsInMountedFile(
  path: string,
  content: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const m of content.matchAll(
    /[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]*@)?([a-z0-9][a-z0-9._-]*)(?::\d+)?/gi,
  ))
    out[`${path} (${++n}) host`] = m[1];
  n++;
  for (const m of content.matchAll(
    /^\s*[a-z_]*host[a-z_]*\s*[:=]\s*["']?([a-z0-9][a-z0-9._-]*)["']?\s*$/gim,
  ))
    out[`${path} (${++n}) host`] = m[1];
  return out;
}
