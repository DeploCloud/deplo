import { clientAddress } from "../http/client-address";

export function authRequestHeaders(
  request: Headers | null | undefined,
  cookie: string,
  opts: {
    // Off on https: honouring a plain twin would let a cookie planted over http sign somebody in on the https address.
    twinCookieNames?: boolean;
  } = {},
): Headers {
  const out = new Headers();
  // The session's device and address: Better Auth reads the address from x-real-ip alone.
  const agent = request?.get("user-agent");
  if (agent) out.set("user-agent", agent);
  const ip = request && clientAddress(request);
  if (ip) out.set("x-real-ip", ip);
  if (cookie)
    out.set(
      "cookie",
      opts.twinCookieNames === false ? cookie : withBothCookieNames(cookie),
    );
  return out;
}

const AUTH_COOKIE_PREFIX = "deplo.";
const SECURE_PREFIX = "__Secure-";

export function withBothCookieNames(cookie: string): string {
  if (!cookie.includes(AUTH_COOKIE_PREFIX)) return cookie;
  const pairs = cookie.split("; ").filter(Boolean);
  const names = new Set(pairs.map((p) => p.slice(0, p.indexOf("="))));
  const extra: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    const twin = name.startsWith(SECURE_PREFIX)
      ? name.slice(SECURE_PREFIX.length)
      : `${SECURE_PREFIX}${name}`;
    const bare = name.startsWith(SECURE_PREFIX)
      ? name.slice(SECURE_PREFIX.length)
      : name;
    if (!bare.startsWith(AUTH_COOKIE_PREFIX) || names.has(twin)) continue;
    names.add(twin);
    extra.push(`${twin}=${pair.slice(eq + 1)}`);
  }
  return extra.length ? `${cookie}; ${extra.join("; ")}` : cookie;
}
