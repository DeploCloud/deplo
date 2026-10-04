import "server-only";

import {
  instanceHost,
  isDeploHostServer,
  isLoopbackIp,
} from "../../deploy/domains";
import { parseHostAddress } from "../../host-address";
import { resolveHostIpv4, resolveHostIpv6 } from "../domains/dns-resolve";
import type { Server } from "../../types/server";

// v6Known: the agent listed every IPv6 the host has, so an AAAA outside `v6` points somewhere else.
export interface ServerAddresses {
  v4: string[];
  v6: string[];
  v6Known: boolean;
}

type AddressedServer = Pick<Server, "id" | "ip" | "host" | "agent">;

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

// The IPv4 a generated name embeds. Null when the server's is unknown: never another machine's address.
export async function serverIpv4(
  server: AddressedServer | null | undefined,
): Promise<string | null> {
  const literal = parseHostAddress(server?.ip);
  if (literal?.kind === "ipv4" && !isLoopbackIp(literal.host))
    return literal.host;
  if (
    !server ||
    literal?.kind === "ipv4" ||
    literal?.host === "localhost" ||
    isDeploHostServer(server)
  )
    return instanceHost();
  const named = await serverAddresses(server, { askAgent: false });
  if (named.v4.length > 0) return named.v4[0];
  return (await serverAddresses(server)).v4[0] ?? null;
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
  if (!server) {
    add(instanceHost());
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
  if (loopback || isDeploHostServer(server)) add(instanceHost());
  return { v4: [...v4], v6: [...v6], v6Known };
}
