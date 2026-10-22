export const REQUEST_TIMEOUT_MS = 15_000;

export interface PanelIdentity {
  name: string;
  portHint: string;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

let doFetch: FetchLike = (input, init) => fetch(input, init);

export function __setMigrationFetchForTest(fn: FetchLike): void {
  doFetch = fn;
}

export function __resetMigrationFetchForTest(): void {
  doFetch = (input, init) => fetch(input, init);
}

function isBareIpHttps(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") return false;
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

export class PanelUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelUnreachableError";
  }
}

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

export function panelSaid(body: string): string {
  const said = body.trim();
  return said.startsWith("<") ? "" : said.slice(0, 300);
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

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

export async function sendRequest(
  baseUrl: string,
  url: string,
  init: RequestInit,
  panel: PanelIdentity,
): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
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

export function refuseRedirect(res: Response, panel: PanelIdentity): void {
  if (res.status < 300 || res.status >= 400) return;
  const to = res.headers.get("location") ?? "";
  throw new Error(
    `${panel.name} answered with a redirect (${res.status})` +
      (to ? ` to ${to.slice(0, 200)}` : "") +
      ". Deplo does not follow redirects here. Point this at the address that answers directly.",
  );
}
