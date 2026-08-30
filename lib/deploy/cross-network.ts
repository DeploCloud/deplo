/**
 * Names an app reaches for that it cannot resolve - the "cannot resolve host" a
 * placement makes unreachable, said out loud before the container tries.
 * https://deplo.build/docs/advanced/network-isolation
 */

/** Why a name is out of reach - the two produce different advice. */
export type OutOfReach =
  /** It lives in another Environment (or at the team's top level). Move one. */
  | "elsewhere"
  /** Same placement, ANOTHER SERVER: a Docker network is local to its host, so
   *  sharing an Environment is not enough. Nothing about the placement fixes it. */
  | "other-host";

/** A name some other stack answers to, and why this app cannot reach it. */
export interface ForeignName {
  /** The DNS name, lowercase - a compose service, a `hostname:`, or `db-<slug>`. */
  name: string;
  /** The network it answers on. Equal to this stack's when `why` is other-host. */
  network: string;
  /** What to tell the user it belongs to, e.g. `Shop / Production`. */
  where: string;
  why: OutOfReach;
}

/** An env var (or compose text) pointing at a name this stack cannot resolve. */
export interface CrossNetworkRef {
  /** The env key that carries it, or "" when it came from the compose file. */
  key: string;
  name: string;
  where: string;
  why: OutOfReach;
}

/** Keys whose whole VALUE is conventionally a hostname. */
const HOST_KEY = /(HOST|ADDR|ADDRESS|SERVER|ENDPOINT|UPSTREAM|TARGET)S?$/i;

/**
 * Whether `value` uses `name` as a host rather than merely containing the word.
 *
 * ponytail: a heuristic, deliberately. It reads a URL authority or a `host:port`,
 * and otherwise trusts a bare value only when the KEY says host - which is what
 * separates `DB_HOST=garage` from `S3_REGION=garage`. Widen it with a measured
 * false negative, never with a guess.
 */
export function usesAsHost(key: string, value: string, name: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const n = name.toLowerCase();
  // scheme://[user[:pass]@]name[:port][/...]
  const authority = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]*@)?([^/:?#\s]+)/i.exec(
    v,
  );
  if (authority && authority[1].toLowerCase() === n) return true;
  // bare host:port, the shape a connection string fragment takes
  const hostPort = /^([a-z0-9][a-z0-9._-]*):\d+$/i.exec(v);
  if (hostPort && hostPort[1].toLowerCase() === n) return true;
  return v.toLowerCase() === n && HOST_KEY.test(key);
}

/**
 * Every foreign name this app's env points at. Deduped by name: one line per
 * unreachable neighbour, not one per variable that mentions it.
 */
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

/**
 * The one line a deploy prints per unreachable neighbour. The advice differs
 * because the remedy does: a name in another Environment is a placement to change,
 * while one on another SERVER is not - a Docker network is local to its host, so
 * no amount of sharing an Environment brings it into reach.
 */
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
