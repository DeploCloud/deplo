import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

let dnsLookup: (host: string) => Promise<{ address: string }[]> = (host) =>
  lookup(host, { all: true });

export function __setDnsLookupForTest(
  fn: (host: string) => Promise<{ address: string }[]>,
): void {
  dnsLookup = fn;
}

export function __resetDnsLookupForTest(): void {
  dnsLookup = (host) => lookup(host, { all: true });
}

export async function assertSafeOutboundUrl(
  raw: string,
  label: string,
  opts?: { allowHttp?: boolean },
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (
    url.protocol !== "https:" &&
    !(opts?.allowHttp && url.protocol === "http:")
  )
    throw new Error(
      `${label} must be an ${opts?.allowHttp ? "http(s)" : "https"} URL`,
    );
  await assertSafeOutboundHost(url.hostname.replace(/^\[|\]$/g, ""), label);
}

export async function assertSafeOutboundHost(
  raw: string,
  label: string,
): Promise<void> {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const refuseError = () =>
    new Error(`${label} must not point at a private or internal address`);
  const refuse = (): never => {
    throw refuseError();
  };
  if (isInternalHost(host)) refuse();
  if (isIP(host) === 6) {
    const bare = host.split("%")[0];
    let canon: string | null = null;
    try {
      canon = new URL(`http://[${bare}]/`).hostname
        .replace(/^\[|\]$/g, "")
        .toLowerCase();
    } catch {
      canon = null;
    }
    if (canon === null) throw refuseError();
    if (isInternalHost(canon)) refuse();
    return;
  }
  if (isIP(host) === 4) return;
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host);
  } catch {
    return;
  }
  if (addresses.some((a) => isInternalHost(a.address.toLowerCase()))) refuse();
}

function isInternalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (host.includes(":")) {
    const n = expandV6(host);
    if (!n) return true;
    if (n.slice(0, 7).every((v) => v === 0) && n[7] <= 1) return true;
    if ((n[0] & 0xffc0) === 0xfe80) return true;
    if ((n[0] & 0xfe00) === 0xfc00) return true;
    const v4 = embeddedV4(n);
    return v4 !== null && isInternalHost(v4);
  }
  return false;
}

function expandV6(host: string): number[] | null {
  const bare = host.split("%")[0];
  const dotted = /^(.*):(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    return expandV6(
      `${dotted[1]}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`,
    );
  }
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [
          ...head,
          ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"),
          ...tail,
        ]
      : head;
  if (groups.length !== 8) return null;
  const n = groups.map((g) =>
    /^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN,
  );
  return n.some(Number.isNaN) ? null : n;
}

function embeddedV4(n: number[]): string | null {
  const v4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeroTo = (k: number) => n.slice(0, k).every((v) => v === 0);
  if (zeroTo(5) && n[5] === 0xffff) return v4(n[6], n[7]);
  if (n[0] === 0x64 && n[1] === 0xff9b && (n[2] === 0 || n[2] === 1))
    return v4(n[6], n[7]);
  if (n[0] === 0x2002) return v4(n[1], n[2]);
  if (n[0] === 0x2001 && n[1] === 0) return v4(n[6] ^ 0xffff, n[7] ^ 0xffff);
  return null;
}
