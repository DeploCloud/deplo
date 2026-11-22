import "server-only";

import { resolve4, resolve6 } from "node:dns/promises";

import { canonicalIpv6 } from "../../host-address";
import { authoritativeAddresses } from "./authoritative-dns";

let dnsResolve4: (name: string) => Promise<string[]> = resolve4;
let dnsResolve6: (name: string) => Promise<string[]> = resolve6;
let atSource: (
  name: string,
) => Promise<{ a: string[]; aaaa: string[] } | null> = authoritativeAddresses;
// A test that stubs the answers is answered by its stubs at the source too; a failed ask is no verdict.
const stubbedSource = async (name: string) => {
  const ask = async (f: (n: string) => Promise<string[]>) => {
    try {
      return await f(name);
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code === "ENODATA" || code === "ENOTFOUND" ? [] : null;
    }
  };
  const [a, aaaa] = await Promise.all([ask(dnsResolve4), ask(dnsResolve6)]);
  if (
    (a ?? []).length + (aaaa ?? []).length === 0 &&
    (a === null || aaaa === null)
  )
    return null;
  return { a: a ?? [], aaaa: (aaaa ?? []).map((x) => canonicalIpv6(x) ?? x) };
};

// Stubbing the A answers also empties the AAAA ones, so no test asks the real resolver by accident.
export function __setDnsResolve4ForTest(
  fn: (name: string) => Promise<string[]>,
): void {
  dnsResolve4 = fn;
  dnsResolve6 = async () => [];
  atSource = stubbedSource;
}

export function __setDnsResolve6ForTest(
  fn: (name: string) => Promise<string[]>,
): void {
  dnsResolve6 = fn;
  atSource = stubbedSource;
}

export function __resetDnsResolve4ForTest(): void {
  dnsResolve4 = resolve4;
  dnsResolve6 = resolve6;
  atSource = authoritativeAddresses;
}

/**
 * A domain's A and AAAA records as its own zone's name servers answer them (decision D of 22 Nov 2026): never a
 * cache, which keeps a record the zone already changed. Null when they could not be asked: no verdict.
 */
export async function resolveAtSource(
  name: string,
): Promise<{ a: string[]; aaaa: string[] } | null> {
  return atSource(name);
}

/**
 * A name's A and AAAA answers, or null when asking failed (a name server that just stopped, a timeout) rather than
 * the name having none: no verdict on the name can be read from that.
 */
export async function lookupHostAddresses(
  name: string,
): Promise<string[] | null> {
  // A domain's records, as its own name servers answer them (resolveAtSource).
  const found = await atSource(name);
  return found ? [...found.a, ...found.aaaa] : null;
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
