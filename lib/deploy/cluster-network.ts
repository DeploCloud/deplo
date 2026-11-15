import { createHash } from "node:crypto";
import { isIP } from "node:net";

// ADR-0047: the servers of a cluster share a private network. What each one is handed is decided here; the
// server agent only runs it.

/** How many host:port pairs one server may be tried on, as the server agent accepts. */
export const MAX_NETWORK_ENDPOINTS = 8;

/** A server's address inside its cluster's tunnel: derived from its id, so it never has to be stored. */
export function networkAddress(serverId: string): string {
  const h = createHash("sha256").update(serverId).digest();
  const groups = [0, 2, 4, 6].map((i) => h.readUInt16BE(i).toString(16));
  return `fdde:9100:0:0:${groups.join(":")}`;
}

/** Every address a server may answer its peers on, once each with its port; none until its agent named a port. */
export function networkEndpoints(addresses: string[], port: number): string[] {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return [];
  const out: string[] = [];
  for (const raw of addresses) {
    const a = raw.trim().replace(/^\[|\]$/g, "");
    const family = isIP(a);
    if (family === 0 || a === "0.0.0.0" || a === "::") continue;
    const ep = family === 6 ? `[${a}]:${port}` : `${a}:${port}`;
    if (!out.includes(ep)) out.push(ep);
    if (out.length === MAX_NETWORK_ENDPOINTS) break;
  }
  return out;
}

export interface NetworkServer {
  serverId: string;
  fingerprint: string;
  /** The WireGuard key its agent answered with; null until it has. */
  publicKey: string | null;
  port: number;
  /** Where it may answer: the address Deplo reaches it on first, then those its agent named. */
  addresses: string[];
}

export interface NetworkTable {
  address: string;
  peers: {
    fingerprint: string;
    publicKey: string;
    address: string;
    endpoints: string[];
  }[];
}

/** What each server of a cluster is handed: every other one whose key is known. */
export function planNetwork(
  servers: NetworkServer[],
): Map<string, NetworkTable> {
  const out = new Map<string, NetworkTable>();
  for (const s of servers) {
    const peers = servers
      .filter((o) => o.serverId !== s.serverId && o.publicKey)
      .map((o) => ({
        fingerprint: o.fingerprint,
        publicKey: o.publicKey!,
        address: networkAddress(o.serverId),
        endpoints: networkEndpoints(o.addresses, o.port),
      }))
      .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
    out.set(s.serverId, { address: networkAddress(s.serverId), peers });
  }
  return out;
}

export type NetworkPath = "direct" | "relay" | "none";
