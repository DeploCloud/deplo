export const REQUEST_TIMEOUT_MS = 15_000;

// The panel a message is about. Only the words differ between products.
export interface PanelIdentity {
  name: string;
  // What it listens on when nothing is in front of it.
  portHint: string;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

let doFetch: FetchLike = (input, init) => fetch(input, init);

// Swap the transport in tests (the import suites drive recorded fixtures).
export function __setMigrationFetchForTest(fn: FetchLike): void {
  doFetch = fn;
}

export function __resetMigrationFetchForTest(): void {
  doFetch = (input, init) => fetch(input, init);
}

// Deliberately not "any IP": `http://` on an IP is the everyday same-machine case.
function isBareIpHttps(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") return false;
    // `hostname` strips the brackets an IPv6 literal is written with.
    return (
      /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(":")
    );
  } catch {
    return false;
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

export function describeTransportError(
  err: unknown,
  baseUrl: string,
  panel: PanelIdentity,
): string {
  const at = `at ${baseUrl}`;
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  )
    return `${panel.name} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds ${at}. It may be slow, or something on the way is dropping the connection.`;

  const cause =
    err instanceof Error
      ? (err.cause as { code?: string } | undefined)
      : undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const message = err instanceof Error ? err.message : String(err);

  switch (code) {
    case "ECONNREFUSED":
      return `Nothing is listening ${at}. Check the port - ${panel.name} serves ${panel.portHint} unless it is behind a proxy.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `That address does not resolve (${baseUrl}). Check the hostname.`;
    case "ECONNRESET":
    case "EPIPE":
      return `The connection to ${baseUrl} was cut before ${panel.name} answered. If ${panel.name} is on plain http there, use http:// rather than https://.`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return `Could not reach ${baseUrl} - no route to it from this machine. If it is on a private network, an instance admin has to allow that.`;
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID": {
      if (isBareIpHttps(baseUrl))
        return `${baseUrl} answered with a certificate this machine does not trust (${code}) - which is what an IP address gets, because the certificate is issued for the panel's NAME. Put the address you open ${panel.name} on in your browser here. The machine's own address is asked for at the next step, and it is not this field.`;
      // Nothing here can be told to accept a certificate, so the only way out is the panel's own http port.
      const host = hostOf(baseUrl);
      const via = host ? `, typically http://${host}${panel.portHint}` : "";
      return `The https certificate ${at} is not one this machine trusts (${code}). Deplo cannot be told to accept it - use ${panel.name}'s plain http address instead${via}.`;
    }
    case "ERR_SSL_WRONG_VERSION_NUMBER":
    case "EPROTO":
      return `${baseUrl} answered, but not over https. Try http:// instead.`;
    default:
      return `Could not reach ${panel.name} ${at}${code ? ` (${code})` : ""}: ${message}.`;
  }
}

// Told apart from a refusal because detection stops on one and carries on past the other.
export class PanelUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelUnreachableError";
  }
}

// A 5xx from whatever sits IN FRONT of the panel, so unreachable rather than a refusal; Cloudflare's 52x included.
const GATEWAY_STATUS = new Set([
  502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527,
]);

function refuseGateway(res: Response, baseUrl: string): void {
  if (!GATEWAY_STATUS.has(res.status)) return;
  const front = res.headers.get("cf-ray") ? "Cloudflare" : "A proxy";
  throw new PanelUnreachableError(
    `${front} answered for ${hostOf(baseUrl) || baseUrl}, but nothing is running behind it (${res.status}). Check the panel is up, or point Deplo at its own address.`,
  );
}

// What the PANEL said, capped - an html body is some other server's words, so it is dropped.
export function panelSaid(body: string): string {
  const said = body.trim();
  return said.startsWith("<") ? "" : said.slice(0, 300);
}

// Kept narrow on purpose: a wrong address or an untrusted certificate must fail on the Connect screen, not three attempts later.
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// How long to wait before each extra attempt. Length = how many there are.
const RETRY_DELAYS_MS = [300, 1_200];

function isTransient(err: unknown): boolean {
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  )
    return true;
  const cause =
    err instanceof Error
      ? (err.cause as { code?: string } | undefined)
      : undefined;
  return typeof cause?.code === "string" && TRANSIENT_CODES.has(cause.code);
}

// A run reads the panel hundreds of times; a single reset used to fail the data phase with every service after it left empty.
export async function sendRequest(
  baseUrl: string,
  url: string,
  init: RequestInit,
  panel: PanelIdentity,
): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      // A retry needs its OWN deadline: `AbortSignal.timeout` stays aborted, so the caller's would abort attempt 2 instantly.
      const res = await doFetch(
        url,
        attempt === 0
          ? init
          : { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      refuseGateway(res, baseUrl);
      return res;
    } catch (e) {
      if (e instanceof PanelUnreachableError) throw e;
      last = e;
      if (attempt >= RETRY_DELAYS_MS.length || !isTransient(e)) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw new PanelUnreachableError(describeTransportError(last, baseUrl, panel));
}

// Origin with no trailing slash and no trailing `/api`, however it was typed.
export function normalizeSourceBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const u = new URL(withScheme);
  if (u.username || u.password)
    throw new Error("Put the key in the API key field, not in the address.");
  const path = u.pathname
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/i, "")
    .replace(/\/api$/i, "");
  return `${u.origin}${path}`;
}

// A redirect is refused rather than followed: the address that answers directly is the one the import keeps using.
export function refuseRedirect(res: Response, panel: PanelIdentity): void {
  if (res.status < 300 || res.status >= 400) return;
  const to = res.headers.get("location") ?? "";
  throw new Error(
    `${panel.name} answered with a redirect (${res.status})` +
      (to ? ` to ${to.slice(0, 200)}` : "") +
      ". Deplo does not follow redirects here. Point this at the address that answers directly.",
  );
}
