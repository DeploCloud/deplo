import "server-only";

import { parseImageRef, DOCKER_HUB_REGISTRY } from "./image-ref";
import { assertSafeOutboundHost } from "../outbound-url";

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

const UA = "Deplo-Registry-Client";
const DEFAULT_TIMEOUT = 8000;

async function isPublicHttpsUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  try {
    await assertSafeOutboundHost(parsed.hostname, "Registry");
    return true;
  } catch {
    return false;
  }
}

function encodeRepoPath(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; body: T | null }> {
  if (!(await isPublicHttpsUrl(url))) return { status: 0, body: null };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, ...(init?.headers ?? {}) },
      cache: "no-store",
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) return { status: 0, body: null };
    let body: T | null = null;
    if (res.ok) {
      body = (await res.json().catch(() => null)) as T | null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(t);
  }
}

export interface ImageSuggestion {
  name: string;
  description?: string;
  official?: boolean;
  stars?: number;
  pulls?: number;
}

interface HubSearchResponse {
  results?: {
    repo_name: string;
    short_description?: string;
    is_official?: boolean;
    star_count?: number;
    pull_count?: number;
  }[];
}

export async function searchImages(
  query: string,
  limit = 8,
): Promise<ImageSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(
    q,
  )}&page_size=${Math.min(limit, 25)}`;
  const { body } = await fetchJson<HubSearchResponse>(url);
  if (!body?.results) return [];
  return body.results.slice(0, limit).map((r) => ({
    name: r.repo_name,
    description: r.short_description || undefined,
    official: r.is_official || undefined,
    stars: r.star_count,
    pulls: r.pull_count,
  }));
}

export interface TagSuggestion {
  name: string;
  lastUpdated?: string;
}

interface HubTagsResponse {
  results?: { name: string; last_updated?: string }[];
}

async function dockerHubTags(
  repository: string,
  limit: number,
  filter?: string,
): Promise<TagSuggestion[]> {
  const params = new URLSearchParams({
    page_size: String(Math.min(limit, 100)),
    ordering: "last_updated",
  });
  if (filter) params.set("name", filter);
  const url = `https://hub.docker.com/v2/repositories/${encodeRepoPath(
    repository,
  )}/tags?${params.toString()}`;
  const { body } = await fetchJson<HubTagsResponse>(url);
  if (!body?.results) return [];
  return body.results.map((t) => ({
    name: t.name,
    lastUpdated: t.last_updated,
  }));
}

function parseBearerChallenge(
  header: string | null,
): { realm: string; service?: string } | null {
  if (!header || !/^Bearer /i.test(header)) return null;
  const realm = header.match(/realm="([^"]+)"/i)?.[1];
  if (!realm) return null;
  const service = header.match(/service="([^"]+)"/i)?.[1];
  return { realm, service };
}

async function ociToken(
  registry: string,
  repository: string,
): Promise<string | null | "none"> {
  const probeUrl = `https://${registry}/v2/`;
  if (!(await isPublicHttpsUrl(probeUrl))) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  let challenge: { realm: string; service?: string } | null = null;
  try {
    const probe = await fetch(probeUrl, {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "manual",
    });
    if (probe.status >= 300 && probe.status < 400) return null;
    if (probe.ok) return "none";
    challenge = parseBearerChallenge(probe.headers.get("www-authenticate"));
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
  if (!challenge) return null;
  if (!(await isPublicHttpsUrl(challenge.realm))) return null;
  const params = new URLSearchParams();
  if (challenge.service) params.set("service", challenge.service);
  params.set("scope", `repository:${repository}:pull`);
  const { body } = await fetchJson<{ token?: string; access_token?: string }>(
    `${challenge.realm}?${params.toString()}`,
  );
  return body?.token ?? body?.access_token ?? null;
}

function ociAuthHeaders(token: string | null | "none"): Record<string, string> {
  return token && token !== "none" ? { Authorization: `Bearer ${token}` } : {};
}

export type CredentialCheck = "ok" | "rejected" | "unknown";

export async function checkRegistryCredential(
  registry: string,
  username: string,
  password: string,
): Promise<CredentialCheck> {
  const bare = registry
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const host =
    bare === DOCKER_HUB_REGISTRY || bare === "index.docker.io"
      ? "registry-1.docker.io"
      : bare;
  const probeUrl = `https://${host}/v2/`;
  if (!(await isPublicHttpsUrl(probeUrl))) return "unknown";

  const basic = {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  let probe: Response;
  try {
    probe = await fetch(probeUrl, {
      headers: { "User-Agent": UA, ...basic },
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return "unknown";
  } finally {
    clearTimeout(t);
  }
  if (probe.ok) return "ok";
  const challenge = parseBearerChallenge(probe.headers.get("www-authenticate"));
  if (!challenge) return probe.status === 401 ? "rejected" : "unknown";
  if (!(await isPublicHttpsUrl(challenge.realm))) return "unknown";

  const params = new URLSearchParams();
  if (challenge.service) params.set("service", challenge.service);
  params.set("account", username);
  const { status } = await fetchJson(
    `${challenge.realm}?${params.toString()}`,
    { headers: basic },
  );
  if (status === 200) return "ok";
  return status === 401 || status === 403 ? "rejected" : "unknown";
}

interface OciTagsResponse {
  tags?: string[] | null;
}

async function ociTags(
  registry: string,
  repository: string,
  limit: number,
  filter?: string,
): Promise<TagSuggestion[]> {
  const token = await ociToken(registry, repository);
  const url = `https://${registry}/v2/${encodeRepoPath(repository)}/tags/list?n=200`;
  const { body } = await fetchJson<OciTagsResponse>(url, {
    headers: { Accept: "application/json", ...ociAuthHeaders(token) },
  });
  let tags = body?.tags ?? [];
  if (filter) {
    const f = filter.toLowerCase();
    tags = tags.filter((t) => t.toLowerCase().includes(f));
  }
  return tags.slice(0, limit).map((name) => ({ name }));
}

export async function listTags(
  imageRef: string,
  limit = 30,
  filter?: string,
): Promise<TagSuggestion[]> {
  const parsed = parseImageRef(imageRef);
  if (!parsed) return [];
  const tags =
    parsed.registry === DOCKER_HUB_REGISTRY
      ? await dockerHubTags(parsed.repository, limit, filter)
      : await ociTags(parsed.registry, parsed.repository, limit, filter);
  return tags.slice(0, limit);
}

export type ImageExistence = "exists" | "absent" | "private" | "unknown";

export interface ExistenceResult {
  status: ImageExistence;
  digest?: string;
}

export async function checkImageExists(
  imageRef: string,
): Promise<ExistenceResult> {
  const parsed = parseImageRef(imageRef);
  if (!parsed) return { status: "unknown" };

  const reference = parsed.digest ?? parsed.tag;
  const registryHost =
    parsed.registry === DOCKER_HUB_REGISTRY
      ? "registry-1.docker.io"
      : parsed.registry;

  const token = await ociToken(registryHost, parsed.repository);
  const manifestUrl = `https://${registryHost}/v2/${encodeRepoPath(
    parsed.repository,
  )}/manifests/${encodeURIComponent(reference)}`;
  if (!(await isPublicHttpsUrl(manifestUrl))) return { status: "unknown" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(manifestUrl, {
      method: "HEAD",
      headers: {
        "User-Agent": UA,
        Accept: MANIFEST_ACCEPT,
        ...ociAuthHeaders(token),
      },
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) return { status: "unknown" };
    if (res.ok) {
      return {
        status: "exists",
        digest: res.headers.get("docker-content-digest") ?? undefined,
      };
    }
    if (res.status === 404) return { status: "absent" };
    if (res.status === 401 || res.status === 403) return { status: "private" };
    return { status: "unknown" };
  } catch {
    return { status: "unknown" };
  } finally {
    clearTimeout(t);
  }
}

interface ManifestDoc {
  config?: { digest?: string };
  manifests?: {
    digest?: string;
    platform?: { os?: string; architecture?: string };
  }[];
}
interface ConfigBlob {
  config?: { ExposedPorts?: Record<string, unknown> };
}

export async function imageExposedPort(
  imageRef: string,
): Promise<number | null> {
  const parsed = parseImageRef(imageRef);
  if (!parsed) return null;
  const registryHost =
    parsed.registry === DOCKER_HUB_REGISTRY
      ? "registry-1.docker.io"
      : parsed.registry;
  const repo = encodeRepoPath(parsed.repository);
  const token = await ociToken(registryHost, parsed.repository);
  const headers = { Accept: MANIFEST_ACCEPT, ...ociAuthHeaders(token) };
  const at = (ref: string) =>
    `https://${registryHost}/v2/${repo}/manifests/${encodeURIComponent(ref)}`;

  let doc = (
    await fetchJson<ManifestDoc>(at(parsed.digest ?? parsed.tag), { headers })
  ).body;
  if (doc?.manifests?.length) {
    const pick =
      doc.manifests.find(
        (m) =>
          m.platform?.os === "linux" && m.platform?.architecture === "amd64",
      ) ?? doc.manifests[0];
    if (!pick?.digest) return null;
    doc = (await fetchJson<ManifestDoc>(at(pick.digest), { headers })).body;
  }
  const configDigest = doc?.config?.digest;
  if (!configDigest) return null;

  const blob = await fetchConfigBlob(
    `https://${registryHost}/v2/${repo}/blobs/${encodeURIComponent(configDigest)}`,
    ociAuthHeaders(token),
  );
  return singleExposedPort(blob?.config?.ExposedPorts);
}

const CONFIG_BLOB_MAX = 256 * 1024;

async function fetchConfigBlob(
  url: string,
  headers: Record<string, string>,
): Promise<ConfigBlob | null> {
  const once = async (
    target: string,
    withAuth: boolean,
  ): Promise<Response | null> => {
    if (!(await isPublicHttpsUrl(target))) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
    try {
      return await fetch(target, {
        headers: { "User-Agent": UA, ...(withAuth ? headers : {}) },
        signal: ctrl.signal,
        cache: "no-store",
        redirect: "manual",
      });
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };

  let res = await once(url, true);
  if (res && res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location");
    res = to ? await once(new URL(to, url).toString(), false) : null;
  }
  if (!res?.ok) return null;
  const text = await res.text().catch(() => "");
  if (!text || text.length > CONFIG_BLOB_MAX) return null;
  try {
    return JSON.parse(text) as ConfigBlob;
  } catch {
    return null;
  }
}

export function singleExposedPort(
  exposed: Record<string, unknown> | undefined | null,
): number | null {
  const tcp = Object.keys(exposed ?? {})
    .filter((k) => !k.includes("/") || k.endsWith("/tcp"))
    .map((k) => Number(k.split("/")[0]))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return tcp.length === 1 ? tcp[0] : null;
}
