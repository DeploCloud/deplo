import "server-only";

import {
  instanceAddresses,
  instanceHost,
  isDeploHostServer,
  isLoopbackIp,
  isWildcardIp,
} from "../../deploy/domains";
import { parseHostAddress } from "../../host-address";
import { resolveHostIpv4, resolveHostIpv6 } from "../domains/dns-resolve";
import { isPrivateAddress, publishedServerAddresses } from "./address-checks";
import type { AddressFamily, Server } from "../../types/server";

// v6Known: the agent listed every IPv6 the host has, so an AAAA outside `v6` points somewhere else.
export interface ServerAddresses {
  v4: string[];
  v6: string[];
  v6Known: boolean;
}

type AddressedServer = Pick<Server, "id" | "ip" | "host" | "agent"> &
  Partial<
    Pick<Server, "generatedAddressFamily" | "preferredAddress" | "deploHost">
  >;

// null when the agent cannot say: unreachable, or too old to report its addresses.
async function askAgent(serverId: string): Promise<string[] | null> {
  const [{ connectAgent }, { HEALTH_HELLO_TIMEOUT_MS }, caps] =
    await Promise.all([
      import("../../infra/agent-client/connect"),
      import("../../infra/agent-client/deadlines"),
      import("../../infra/agent-client/hello-capabilities"),
    ]);
  try {
    const conn = await connectAgent(serverId);
    try {
      const hello = await conn.hello(HEALTH_HELLO_TIMEOUT_MS);
      return hello.capabilities?.includes(caps.HOST_ADDRESSES_CAPABILITY)
        ? (hello.publicAddresses ?? [])
        : null;
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
}

let agentAddresses = askAgent;

export function __setAgentAddressesForTest(
  fn: (serverId: string) => Promise<string[] | null>,
): void {
  agentAddresses = fn;
}

export function __resetAgentAddressesForTest(): void {
  agentAddresses = askAgent;
}

function onDeploHost(server: AddressedServer | null | undefined): boolean {
  const literal = parseHostAddress(server?.ip);
  return (
    !server ||
    literal?.host === "localhost" ||
    (!!literal && isLoopbackIp(literal.host)) ||
    isDeploHostServer(server)
  );
}

function ofFamily(a: ServerAddresses, family: AddressFamily): string[] {
  return family === "ipv6" ? a.v6.filter(isWildcardIp) : a.v4;
}

// The chosen kind first, then the other: a name on the wrong kind still beats no name at all.
function pickAddress(
  a: ServerAddresses,
  family: AddressFamily | null,
): string | null {
  const first = family ?? "ipv4";
  const other = first === "ipv4" ? "ipv6" : "ipv4";
  return ofFamily(a, first)[0] ?? ofFamily(a, other)[0] ?? null;
}

/** Any public IP, OR a private/VPN IPv4 or IPv6 ULA that an admin explicitly picks as preferred. */
export function isPreferredIp(raw: string): boolean {
  const parsed = parseHostAddress(raw);
  if (!parsed || parsed.kind === "hostname" || isLoopbackIp(parsed.host))
    return false;
  if (isWildcardIp(parsed.host)) return true;
  return parsed.kind === "ipv6" && isPrivateAddress(parsed.host);
}

function preferredServerIp(
  server: AddressedServer | null | undefined,
): string | null {
  const raw = server?.preferredAddress?.trim();
  if (!raw) return null;
  const parsed = parseHostAddress(raw);
  if (!parsed || !isPreferredIp(parsed.host)) return null;
  return parsed.host;
}

function preferFirst(list: string[], preferred: string | null): string[] {
  if (!preferred || !list.includes(preferred)) return list;
  return [preferred, ...list.filter((a) => a !== preferred)];
}

// The address a generated name embeds. Null when the server's is unknown: never another machine's address.
export async function serverWildcardIp(
  server: AddressedServer | null | undefined,
): Promise<string | null> {
  const family = server?.generatedAddressFamily ?? null;
  const preferred = preferredServerIp(server);
  const deploHost = onDeploHost(server);
  // Once Deplo checked its addresses, only one it proved reaches it is ever named (ADR-0050).
  // Applies to the Deplo host too: if IPv4 does not answer (e.g. behind CGNAT), Automatic falls back to IPv6.
  // Automatic only considers public addresses; an explicit preferredAddress may also pick an active private/VPN IP.
  const proven = server ? await publishedServerAddresses(server.id) : null;
  if (proven) {
    if (preferred) {
      const provenAll = isPrivateAddress(preferred)
        ? await publishedServerAddresses(server!.id, Date.now(), {
            includePrivate: true,
          })
        : proven;
      if (
        provenAll &&
        (provenAll.v4.includes(preferred) || provenAll.v6.includes(preferred))
      )
        return preferred;
    }
    // The one it carries now stays while it is still used: another address appearing renames nothing.
    const kind = family ?? (proven.v4.length > 0 ? "ipv4" : "ipv6");
    const current = server?.ip ?? "";
    if ((kind === "ipv4" ? proven.v4 : proven.v6).includes(current))
      return current;
    return pickAddress({ ...proven, v6Known: true }, family);
  }
  if (preferred) return preferred;
  // Automatic on the Deplo host is the kind the installer chose. Its address is the row's once
  // Settings moved it: DEPLO_SERVER_IP stays where the installer saw the machine.
  const kind =
    family ??
    (deploHost ? (parseHostAddress(instanceHost())?.kind ?? "ipv4") : "ipv4");
  const literal = parseHostAddress(server?.ip);
  if (
    literal &&
    literal.kind === kind &&
    isWildcardIp(literal.host) &&
    !isLoopbackIp(literal.host)
  )
    return literal.host;
  if (deploHost && !family) return instanceHost();
  if (deploHost) {
    const own = instanceAddresses();
    const chosen = family === "ipv6" ? own.v6 : own.v4;
    if (chosen) return chosen;
    return server
      ? (pickAddress(await serverAddresses(server), family) ?? instanceHost())
      : instanceHost();
  }
  const named = await serverAddresses(server!, { askAgent: false });
  const quick = ofFamily(named, family ?? "ipv4")[0];
  if (quick) return quick;
  return pickAddress(await serverAddresses(server!), family);
}

// What the server could be reached at for each kind, and the one its generated names use today.
export async function serverAddressChoices(server: AddressedServer): Promise<{
  ipv4: string | null;
  ipv6: string | null;
  inUse: string | null;
}> {
  const live = await serverAddresses(server, { anyFamily: true });
  return {
    ipv4: live.v4[0] ?? null,
    ipv6: live.v6.find(isWildcardIp) ?? null,
    inUse: await serverWildcardIp(server),
  };
}

// Read live, never stored: the address it was added at, its name's A/AAAA records, and its agent's own list.
export async function serverAddresses(
  server: AddressedServer | null | undefined,
  opts: {
    askAgent?: boolean;
    anyFamily?: boolean;
    includePrivate?: boolean;
  } = {},
): Promise<ServerAddresses> {
  // Once Deplo checked them: what it proved reaches the server, of the family the server's setting names.
  const preferred = preferredServerIp(server);
  const proven = server
    ? await publishedServerAddresses(server.id, Date.now(), {
        includePrivate: opts.includePrivate,
      })
    : null;
  if (proven) {
    const family = opts.anyFamily
      ? null
      : (server?.generatedAddressFamily ?? null);
    let v4 = family === "ipv6" ? [] : [...proven.v4];
    let v6 = family === "ipv4" ? [] : [...proven.v6];
    // If an admin explicitly picked an active private/VPN IP as primary, include it for DNS checks and hints.
    if (preferred && !opts.includePrivate && isPrivateAddress(preferred)) {
      const provenAll = await publishedServerAddresses(server!.id, Date.now(), {
        includePrivate: true,
      });
      if (provenAll?.v4.includes(preferred) && family !== "ipv6")
        v4 = [preferred, ...v4];
      if (provenAll?.v6.includes(preferred) && family !== "ipv4")
        v6 = [preferred, ...v6];
    }
    return {
      v4: preferFirst(v4, preferred),
      v6: preferFirst(v6, preferred),
      v6Known: true,
    };
  }
  const v4 = new Set<string>();
  const v6 = new Set<string>();
  // 192.0.0.0/24 is deplo-clat's IPv4 on an IPv6-only host: nobody reaches the server there.
  const add = (raw: string) => {
    const p = parseHostAddress(raw);
    if (
      p?.kind === "ipv4" &&
      !isLoopbackIp(p.host) &&
      !p.host.startsWith("192.0.0.")
    )
      v4.add(p.host);
    if (p?.kind === "ipv6" && p.host !== "::1") v6.add(p.host);
  };
  let v6Known = false;
  const addInstance = () => {
    const own = instanceAddresses();
    for (const a of [instanceHost(), own.v4, own.v6]) if (a) add(a);
  };
  if (!server) {
    addInstance();
    return { v4: [...v4], v6: [...v6], v6Known };
  }
  const names = new Set<string>();
  let loopback = false;
  for (const raw of [server.ip, server.host]) {
    const p = parseHostAddress(raw);
    if (p?.host === "localhost" || (p?.kind === "ipv4" && isLoopbackIp(p.host)))
      loopback = true;
    else if (p?.kind === "hostname") names.add(p.host);
    else if (raw) add(raw);
  }
  const [answers, reported] = await Promise.all([
    Promise.all(
      [...names].map(async (n) => [
        ...(await resolveHostIpv4(n)),
        ...(await resolveHostIpv6(n)),
      ]),
    ),
    server.agent?.certFingerprint && opts.askAgent !== false
      ? agentAddresses(server.id)
      : null,
  ]);
  answers.flat().forEach(add);
  if (reported) {
    v6Known = true;
    reported.forEach(add);
  }
  // A loopback address can only mean the machine Deplo itself runs on.
  if (loopback || isDeploHostServer(server)) addInstance();
  return {
    v4: preferFirst([...v4], preferred),
    v6: preferFirst([...v6], preferred),
    v6Known,
  };
}

/** Where its link comes from when that is none of its own addresses: it is behind a router (ADR-0050). */
export function connectsFromElsewhere(
  server: Pick<Server, "connectedFrom" | "behindRouter" | "deploHost">,
): string | null {
  return server.behindRouter && !server.deploHost
    ? (server.connectedFrom ?? null)
    : null;
}
