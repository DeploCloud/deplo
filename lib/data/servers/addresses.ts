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
import type { AddressFamily, Server } from "../../types/server";

// v6Known: the agent listed every IPv6 the host has, so an AAAA outside `v6` points somewhere else.
export interface ServerAddresses {
  v4: string[];
  v6: string[];
  v6Known: boolean;
}

type AddressedServer = Pick<Server, "id" | "ip" | "host" | "agent"> &
  Partial<Pick<Server, "generatedAddressFamily">>;

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

// The address a generated name embeds. Null when the server's is unknown: never another machine's address.
export async function serverWildcardIp(
  server: AddressedServer | null | undefined,
): Promise<string | null> {
  const family = server?.generatedAddressFamily ?? null;
  const deploHost = onDeploHost(server);
  // Automatic on the Deplo host is the kind the installer chose, not the address the row was enrolled at.
  if (deploHost && !family) return instanceHost();
  const literal = parseHostAddress(server?.ip);
  if (
    literal &&
    literal.kind === (family ?? "ipv4") &&
    isWildcardIp(literal.host) &&
    !isLoopbackIp(literal.host)
  )
    return literal.host;
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
  const live = await serverAddresses(server);
  return {
    ipv4: live.v4[0] ?? null,
    ipv6: live.v6.find(isWildcardIp) ?? null,
    inUse: await serverWildcardIp(server),
  };
}

// Read live, never stored: the address it was added at, its name's A/AAAA records, and its agent's own list.
export async function serverAddresses(
  server: AddressedServer | null | undefined,
  opts: { askAgent?: boolean } = {},
): Promise<ServerAddresses> {
  const v4 = new Set<string>();
  const v6 = new Set<string>();
  const add = (raw: string) => {
    const p = parseHostAddress(raw);
    if (p?.kind === "ipv4" && !isLoopbackIp(p.host)) v4.add(p.host);
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
  return { v4: [...v4], v6: [...v6], v6Known };
}
