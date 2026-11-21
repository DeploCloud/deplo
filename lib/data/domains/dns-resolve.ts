import "server-only";

import { resolve4, resolve6 } from "node:dns/promises";

import { canonicalIpv6 } from "../../host-address";

let dnsResolve4: (name: string) => Promise<string[]> = resolve4;
let dnsResolve6: (name: string) => Promise<string[]> = resolve6;

// Stubbing the A answers also empties the AAAA ones, so no test asks the real resolver by accident.
export function __setDnsResolve4ForTest(
  fn: (name: string) => Promise<string[]>,
): void {
  dnsResolve4 = fn;
  dnsResolve6 = async () => [];
}

export function __setDnsResolve6ForTest(
  fn: (name: string) => Promise<string[]>,
): void {
  dnsResolve6 = fn;
}

export function __resetDnsResolve4ForTest(): void {
  dnsResolve4 = resolve4;
  dnsResolve6 = resolve6;
}

/**
 * A name's A and AAAA answers, or null when asking failed (a name server that just stopped, a timeout) rather than
 * the name having none: no verdict on the name can be read from that.
 */
export async function lookupHostAddresses(
  name: string,
): Promise<string[] | null> {
  const ask = async (f: (n: string) => Promise<string[]>) => {
    try {
      return await f(name);
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code === "ENODATA" || code === "ENOTFOUND" ? [] : null;
    }
  };
  const [a, aaaa] = await Promise.all([ask(dnsResolve4), ask(dnsResolve6)]);
  const found = [
    ...(a ?? []),
    ...(aaaa ?? []).map((x) => canonicalIpv6(x) ?? x),
  ];
  return found.length === 0 && (a === null || aaaa === null) ? null : found;
}

export async function resolveHostIpv4(name: string): Promise<string[]> {
  try {
    return await dnsResolve4(name);
  } catch {
    return [];
  }
}

export async function resolveHostIpv6(name: string): Promise<string[]> {
  try {
    return (await dnsResolve6(name)).map((a) => canonicalIpv6(a) ?? a);
  } catch {
    return [];
  }
}
