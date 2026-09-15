import { HOSTS } from "./hosts";
import type { GitCredential, GitProviderApi } from "./types";

const UA = "deplo";
const MAX_FILE_BYTES = 1_000_000;
export const PER_PAGE = 100;
export const REPO_PAGES = 5;

function url(c: GitCredential, path: string): string {
  const origin = HOSTS[c.provider]?.apiBaseUrl ?? c.baseUrl;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

const FULL_NAME_RE = /^[\w.~-]+(?:\/[\w.~-]+)+$/;

export function assertFullName(fullName: string): string {
  if (!FULL_NAME_RE.test(fullName)) throw new Error("Invalid repository");
  return fullName;
}

const REQUEST_TIMEOUT_MS = 15_000;

// ponytail: a redirect is refused, not re-validated. If a host is ever found that
function timedFetch(target: string, init: RequestInit): Promise<Response> {
  return fetch(target, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function call(
  c: GitCredential,
  path: string,
  init: RequestInit & { auth: Record<string, string> },
): Promise<Response> {
  const { auth, ...rest } = init;
  const res = await timedFetch(url(c, path), {
    ...rest,
    headers: {
      Accept: "application/json",
      "User-Agent": UA,
      ...auth,
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location") ?? "";
    throw new Error(
      `${HOSTS[c.provider].label} answered with a redirect (${res.status})` +
        (to ? ` to ${to.slice(0, 200)}` : "") +
        ". Deplo does not follow redirects here. Point this connection at the address that answers directly.",
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300).trim();
    throw new Error(
      `${HOSTS[c.provider].label} request failed (${res.status})` +
        (detail ? `: ${detail}` : ""),
    );
  }
  return res;
}

export async function json<T>(
  c: GitCredential,
  path: string,
  init: RequestInit & { auth: Record<string, string> },
): Promise<T> {
  return (await call(c, path, init)).json() as Promise<T>;
}

async function readCapped(res: Response): Promise<Buffer | null> {
  if (!res.ok) return null;
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_FILE_BYTES) return null;
  const buf = await res
    .arrayBuffer()
    .then((b) => Buffer.from(b))
    .catch(() => null);
  if (buf == null || buf.byteLength > MAX_FILE_BYTES) return null;
  return buf;
}

export async function fetchRaw(
  c: GitCredential,
  path: string,
  auth: Record<string, string>,
): Promise<Buffer | null> {
  const res = await timedFetch(url(c, path), {
    headers: { "User-Agent": UA, ...auth },
  });
  return readCapped(res);
}

export async function readProviderText(
  api: GitProviderApi,
  c: GitCredential,
  fullName: string,
  ref: string,
  path: string,
): Promise<string | null> {
  const bytes = await api.readFileBytes(c, fullName, ref, path);
  return bytes ? bytes.toString("utf8") : null;
}
