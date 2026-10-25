import "server-only";

import { getDb } from "../../db/client";
import { panelFallbackHost } from "../../deploy/domains";
import { panelRoute } from "../../deploy/traefik-stack";
import { deploHostServer, reachableHostIp } from "./settings-store";

/** The panel's fallback ("backup") address, on or off: its second name, served wherever `panelUrl` is. */
export async function panelFallbackUrl(
  panelUrl: string,
): Promise<string | null> {
  const host = await deploHostServer();
  return fallbackOn(panelUrl, host, await routedFallback(host?.id));
}

/** The same for a page, which never waits on the panel's server: what its proxy last said, else the derived name. */
export async function panelFallbackUrlNow(
  panelUrl: string,
): Promise<string | null> {
  const host = await deploHostServer();
  return fallbackOn(panelUrl, host, knownRoutedFallback(host?.id));
}

function fallbackOn(
  panelUrl: string,
  host: { ip?: string } | null,
  routed: string | null | undefined,
): string | null {
  // What the proxy routes: an older install keeps its own zone, and behind NAT the installer named the public IP.
  const ip = reachableHostIp(host);
  const name = routed ?? (ip ? panelFallbackHost(ip) : null);
  if (!name) return null;
  const url = new URL(panelUrl);
  url.hostname = name;
  return url.origin;
}

const ROUTED_TTL_MS = 5 * 60_000;

// On globalThis like the freeze: route handlers and instrumentation share one answer.
const KEY = Symbol.for("deplo.panel-fallback.routed");
// `known`: the last name the proxy gave, kept while a newer read is on its way.
type Cached = {
  at: number;
  db: unknown;
  name: Promise<string | null>;
  known?: string | null;
};
const slot = globalThis as unknown as { [KEY]?: Cached };

/** Every route Deplo writes names its fallback here, so no Hello waits on a read of the proxy. */
export function rememberRoutedFallback(name: string | null): void {
  slot[KEY] = {
    at: Date.now(),
    db: getDb(),
    name: Promise.resolve(name),
    known: name,
  };
}

export function forgetRoutedFallback(): void {
  delete slot[KEY];
}

function fresh(hit: Cached | undefined): hit is Cached {
  return !!hit && hit.db === getDb() && Date.now() - hit.at < ROUTED_TTL_MS;
}

function routedFallback(hostId?: string): Promise<string | null> {
  if (!hostId) return Promise.resolve(null);
  const hit = slot[KEY];
  return fresh(hit) ? hit.name : refresh(hostId).name;
}

// Never waits: undefined until the proxy has answered once, and a stale answer starts a new read.
function knownRoutedFallback(hostId?: string): string | null | undefined {
  if (!hostId) return null;
  const hit = slot[KEY];
  if (!fresh(hit)) return refresh(hostId).known;
  return hit.known;
}

function refresh(hostId: string): Cached {
  const prev = slot[KEY];
  const read = readRoutedFallback(hostId);
  const entry: Cached = {
    at: Date.now(),
    db: getDb(),
    name: read.then((n) => n ?? null),
    known: prev?.db === getDb() ? prev.known : undefined,
  };
  slot[KEY] = entry;
  void read.then((n) => {
    if (slot[KEY] !== entry) return;
    // A read that failed is not an answer: the next caller asks again.
    if (n === undefined) entry.at = 0;
    else entry.known = n;
  });
  return entry;
}

// undefined: the proxy could not be read.
async function readRoutedFallback(
  hostId: string,
): Promise<string | null | undefined> {
  try {
    const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
    const yaml = (await fetchHostInfo(hostId)).traefikComposeYaml;
    return yaml ? (panelRoute(yaml)?.fallbackDomain ?? null) : null;
  } catch {
    return undefined;
  }
}
