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

/** A name some other stack of this team answers to, and how it relates to us. */
export interface Neighbour {
  /** The DNS name, lowercase - a compose service, a `hostname:`, or `db-<slug>`. */
  name: string;
  /** The network it answers on. Equal to this stack's unless `why` is elsewhere. */
  network: string;
  /** What to tell the user it belongs to, e.g. `Shop / Production`. */
  where: string;
  /** `reachable` is same network AND same host: not a warning, a possible CLASH. */
  why: OutOfReach | "reachable";
}

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
const HOST_KEY =
  /(HOSTNAME|HOST|ADDR|ADDRESS|SERVER|ENDPOINT|UPSTREAM|TARGET)S?$/i;

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

/** One name this stack puts on its network that a neighbour already answers to. */
export interface NameClash {
  name: string;
  where: string;
}

/**
 * The names this stack would take over. Docker's DNS round-robins a name two
 * containers both claim, so half the lookups reach the wrong app - the same theft
 * ADR-0028 fixed BETWEEN Environments, which inside one is still possible.
 */
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

/** The one line a deploy prints per name two stacks now both answer to. */
export function nameClashMessage(clash: NameClash): string {
  return (
    `\`${clash.name}\` is also answered by a stack in ${clash.where}, on the same ` +
    `network as this one. Docker splits the lookups between them, so half will reach ` +
    `the wrong container. Rename the service, or its \`hostname:\`.`
  );
}

/**
 * The hostnames a mounted CONFIG FILE points at, as `{where: host}` pairs the
 * cross-network detector can read like env vars.
 *
 * `usesAsHost` reads a whole VALUE - an env var is one - and a config file is a
 * document, so passing its text straight in matched nothing. An nginx
 * `proxy_pass http://db-shop:5432;` names a neighbour exactly as squarely as
 * `DATABASE_URL` does, and for those stacks the warning was silent.
 */
export function hostsInMountedFile(
  path: string,
  content: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  // scheme://host[:port] - the shape a proxy_pass, an upstream or a URL takes.
  for (const m of content.matchAll(
    /[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]*@)?([a-z0-9][a-z0-9._-]*)(?::\d+)?/gi,
  ))
    out[`${path} (${++n}) host`] = m[1];
  n++;
  // bare `host: name` / `host = name`, how a config.yml or an ini names one.
  for (const m of content.matchAll(
    /^\s*[a-z_]*host[a-z_]*\s*[:=]\s*["']?([a-z0-9][a-z0-9._-]*)["']?\s*$/gim,
  ))
    out[`${path} (${++n}) host`] = m[1];
  return out;
}
