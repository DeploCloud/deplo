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
