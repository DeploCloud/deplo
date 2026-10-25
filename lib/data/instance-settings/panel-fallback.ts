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
  // What the proxy routes: an older install keeps its own zone, and behind NAT the installer named the public IP.
  const ip = reachableHostIp(host);
  const name =
    (await routedFallback(host?.id)) ?? (ip ? panelFallbackHost(ip) : null);
  if (!name) return null;
  const url = new URL(panelUrl);
  url.hostname = name;
  return url.origin;
}

const ROUTED_TTL_MS = 5 * 60_000;

// On globalThis like the freeze: route handlers and instrumentation share one answer.
const KEY = Symbol.for("deplo.panel-fallback.routed");
type Cached = { at: number; db: unknown; name: Promise<string | null> };
const slot = globalThis as unknown as { [KEY]?: Cached };

/** Every route Deplo writes names its fallback here, so no Hello waits on a read of the proxy. */
export function rememberRoutedFallback(name: string | null): void {
  slot[KEY] = { at: Date.now(), db: getDb(), name: Promise.resolve(name) };
}

export function forgetRoutedFallback(): void {
  delete slot[KEY];
}

function routedFallback(hostId?: string): Promise<string | null> {
  if (!hostId) return Promise.resolve(null);
  const hit = slot[KEY];
  if (hit && hit.db === getDb() && Date.now() - hit.at < ROUTED_TTL_MS)
    return hit.name;
  const read = readRoutedFallback(hostId);
  const name = read.then((n) => n ?? null);
  slot[KEY] = { at: Date.now(), db: getDb(), name };
  // A read that failed is not an answer: the next caller asks again.
  void read.then((n) => {
    if (n === undefined && slot[KEY]?.name === name) forgetRoutedFallback();
  });
  return name;
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
