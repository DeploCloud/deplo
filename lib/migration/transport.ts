/**
 * The HTTP half both source clients share: one timeout, one test seam, and one
 * vocabulary for a connection that did not work.
 */

/** How long one call to a panel may take. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The panel a message is about. Only the words differ between products. */
export interface PanelIdentity {
  name: string;
  /** What it listens on when nothing is in front of it. */
  portHint: string;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

let doFetch: FetchLike = (input, init) => fetch(input, init);

/** Swap the transport in tests (the import suites drive recorded fixtures). */
export function __setMigrationFetchForTest(fn: FetchLike): void {
  doFetch = fn;
}

export function __resetMigrationFetchForTest(): void {
  doFetch = (input, init) => fetch(input, init);
}

/**
 * An https URL whose host is a bare IP. Deliberately not "any IP": `http://` on an
 * IP is the everyday same-machine case, and the placeholder on that very field
 * suggests one.
 */
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

/**
 * A transport failure, said out loud. All of these read the same otherwise, so the
 * user is left guessing on the one screen where guessing costs the most.
 */
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
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      // The trap, named.
      return isBareIpHttps(baseUrl)
        ? `${baseUrl} answered with a certificate this machine does not trust (${code}) - which is what an IP address gets, because the certificate is issued for the panel's NAME. Put the address you open ${panel.name} on in your browser here. The machine's own address is asked for at the next step, and it is not this field.`
        : `The https certificate ${at} is not one this machine trusts (${code}).`;
    case "ERR_SSL_WRONG_VERSION_NUMBER":
    case "EPROTO":
      return `${baseUrl} answered, but not over https. Try http:// instead.`;
    default:
      return `Could not reach ${panel.name} ${at}${code ? ` (${code})` : ""}: ${message}.`;
  }
}

/** Every call goes out through here so no caller can leak a bare "fetch failed". */
export async function sendRequest(
  baseUrl: string,
  url: string,
  init: RequestInit,
  panel: PanelIdentity,
): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (e) {
    throw new Error(describeTransportError(e, baseUrl, panel));
  }
}

/** Origin with no trailing slash and no trailing `/api`, however it was typed. */
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

/** A redirect is refused rather than followed: the address that answers directly
 *  is the one the import has to keep using. */
export function refuseRedirect(res: Response, panel: PanelIdentity): void {
  if (res.status < 300 || res.status >= 400) return;
  const to = res.headers.get("location") ?? "";
  throw new Error(
    `${panel.name} answered with a redirect (${res.status})` +
      (to ? ` to ${to.slice(0, 200)}` : "") +
      ". Deplo does not follow redirects here. Point this at the address that answers directly.",
  );
}
