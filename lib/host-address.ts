// One spelling per address: an IPv6 literal is stored bare and compressed, and bracketed only where a port follows.
export type HostKind = "ipv4" | "ipv6" | "hostname";

export interface HostAddress {
  kind: HostKind;
  host: string;
}

export const HOST_ADDRESS_ERROR =
  "Enter an IP address or a host name, like 203.0.113.10, 2001:db8::1 or server.example.com.";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function parseHostAddress(
  raw: string | null | undefined,
): HostAddress | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const v4 = IPV4.exec(s);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    return octets.every((o) => o <= 255)
      ? { kind: "ipv4", host: octets.join(".") }
      : null;
  }
  const bare = s.replace(/^\[(.*)\]$/, "$1");
  if (bare.includes(":")) {
    const v6 = canonicalIpv6(bare);
    return v6 ? { kind: "ipv6", host: v6 } : null;
  }
  const name = s.replace(/\.$/, "");
  if (name.length > 253 || /^[\d.]+$/.test(name)) return null;
  return name.split(".").every((l) => LABEL.test(l))
    ? { kind: "hostname", host: name }
    : null;
}

export function canonicalIpv6(raw: string): string | null {
  if (!/^[0-9a-f:.]+$/i.test(raw)) return null;
  try {
    return new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

// The stored spelling of an address, for comparing two of them; an unreadable one compares as typed.
export function canonicalHost(raw: string | null | undefined): string {
  return parseHostAddress(raw)?.host ?? (raw ?? "").trim().toLowerCase();
}

export function isIpLiteral(host: string | null | undefined): boolean {
  const kind = parseHostAddress(host)?.kind;
  return kind === "ipv4" || kind === "ipv6";
}

// One IPv6 subscriber holds a whole /64, so a per-address key there is a fresh bucket per request.
export function clientKeyAddress(raw: string): string {
  const s = raw.trim().toLowerCase();
  const v6 = canonicalIpv6(s.replace(/^\[(.*)\]$/, "$1"));
  if (!v6) return s;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const [head, tail] = v6.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export function bracketHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function formatHostPort(host: string, port: number | string): string {
  return `${bracketHost(host)}:${port}`;
}
