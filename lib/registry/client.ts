import "server-only";

/**
 * Server-side container-registry client: image-name search, tag listing, and
 * existence checks across Docker Hub, GHCR, GitLab, Quay and any generic OCI
 * registry. MUST run server-side — none of these hosts send CORS headers, so a
 * browser fetch is blocked; the dashboard calls these through an API route.
 *
 * Two protocols are involved:
 *  - Docker Hub's bespoke JSON API (hub.docker.com) for NAME search and rich
 *    tag metadata. Hub is the only registry with a public name-search endpoint.
 *  - The OCI Distribution v2 API (everything else, and Hub for existence) with
 *    the standard `WWW-Authenticate: Bearer` token dance for anonymous pulls.
 *
 * Endpoints and response shapes here were verified live against the real APIs.
 */

import { parseImageRef, DOCKER_HUB_REGISTRY } from "./image-ref";

/** Manifest media types to advertise so multi-arch (OCI index / manifest list)
 * tags resolve on a HEAD instead of 404/406-ing. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

const UA = "Deplo-Registry-Client";
const DEFAULT_TIMEOUT = 8000;

async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; body: T | null }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, ...(init?.headers ?? {}) },
      cache: "no-store",
    });
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

// ---------------------------------------------------------------------------
// Docker Hub name search
// ---------------------------------------------------------------------------

export interface ImageSuggestion {
  /** Canonical reference to insert, e.g. "postgres", "grafana/grafana". */
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

/**
 * Suggest image names from Docker Hub for a query fragment. Official images
 * come back as a bare name (`postgres`) with `is_official: true`; others as
 * `namespace/name`. Returns [] for non-Hub registries (no search API exists).
 */
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

// ---------------------------------------------------------------------------
// Tag listing
// ---------------------------------------------------------------------------

export interface TagSuggestion {
  name: string;
  /** ISO timestamp when known (Docker Hub provides it; OCI tags/list does not). */
  lastUpdated?: string;
}

interface HubTagsResponse {
  results?: { name: string; last_updated?: string }[];
}

/**
 * Docker Hub tags carry rich metadata, including last-updated for sorting.
 * `filter` is passed through Hub's server-side `name=` parameter, which is what
 * surfaces a specific version (e.g. `2.0`) even when it's an OLD tag — plain
 * newest-first pagination would never reach it on images with many tags.
 */
async function dockerHubTags(
  repository: string,
  limit: number,
  filter?: string,
): Promise<TagSuggestion[]> {
  // Hub expects the namespaced path; image-ref already expands bare → library/.
  const params = new URLSearchParams({
    page_size: String(Math.min(limit, 100)),
    ordering: "last_updated",
  });
  if (filter) params.set("name", filter);
  const url = `https://hub.docker.com/v2/repositories/${repository}/tags?${params.toString()}`;
  const { body } = await fetchJson<HubTagsResponse>(url);
  if (!body?.results) return [];
  return body.results.map((t) => ({ name: t.name, lastUpdated: t.last_updated }));
}

/** A parsed `WWW-Authenticate: Bearer realm=…,service=…` challenge. */
function parseBearerChallenge(
  header: string | null,
): { realm: string; service?: string } | null {
  if (!header || !/^Bearer /i.test(header)) return null;
  const realm = header.match(/realm="([^"]+)"/i)?.[1];
  if (!realm) return null;
  const service = header.match(/service="([^"]+)"/i)?.[1];
  return { realm, service };
}

/**
 * Obtain an anonymous pull token for an OCI registry by probing `/v2/` for its
 * Bearer challenge, then requesting a repo-scoped token. Returns null when the
 * registry needs no token (it answered `/v2/` with 200).
 */
async function ociToken(
  registry: string,
  repository: string,
): Promise<string | null | "none"> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  let challenge: { realm: string; service?: string } | null = null;
  try {
    const probe = await fetch(`https://${registry}/v2/`, {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (probe.ok) return "none"; // open registry, no auth needed
    challenge = parseBearerChallenge(probe.headers.get("www-authenticate"));
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
  if (!challenge) return null;
  const params = new URLSearchParams();
  if (challenge.service) params.set("service", challenge.service);
  params.set("scope", `repository:${repository}:pull`);
  const { body } = await fetchJson<{ token?: string; access_token?: string }>(
    `${challenge.realm}?${params.toString()}`,
  );
  return body?.token ?? body?.access_token ?? null;
}

/** Build the auth headers for an OCI request given a token result. */
function ociAuthHeaders(token: string | null | "none"): Record<string, string> {
  return token && token !== "none" ? { Authorization: `Bearer ${token}` } : {};
}

interface OciTagsResponse {
  tags?: string[] | null;
}

/**
 * Generic OCI `tags/list`. The spec has no server-side name filter, so it
 * returns the whole list (we request a generous page) and we filter for the
 * fragment client-side — which is fine because the full list is returned at once.
 */
async function ociTags(
  registry: string,
  repository: string,
  limit: number,
  filter?: string,
): Promise<TagSuggestion[]> {
  const token = await ociToken(registry, repository);
  const url = `https://${registry}/v2/${repository}/tags/list?n=200`;
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

/**
 * List tags for an image reference, choosing the richest available source.
 * `filter` (the tag fragment the user has typed) is forwarded so a specific
 * version surfaces even when it isn't among the newest tags.
 */
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

// ---------------------------------------------------------------------------
// Existence check
// ---------------------------------------------------------------------------

export type ImageExistence = "exists" | "absent" | "private" | "unknown";

export interface ExistenceResult {
  status: ImageExistence;
  /** Resolved digest from the manifest HEAD, when the image exists. */
  digest?: string;
}

/**
 * Check whether `image:tag` resolves via a manifest HEAD on the registry v2 API.
 *  200 → exists, 404 → absent, 401/403 (after a token) → private/forbidden.
 */
export async function checkImageExists(
  imageRef: string,
): Promise<ExistenceResult> {
  const parsed = parseImageRef(imageRef);
  if (!parsed) return { status: "unknown" };

  const reference = parsed.digest ?? parsed.tag;
  const registryHost =
    parsed.registry === DOCKER_HUB_REGISTRY ? "registry-1.docker.io" : parsed.registry;

  const token = await ociToken(registryHost, parsed.repository);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(
      `https://${registryHost}/v2/${parsed.repository}/manifests/${encodeURIComponent(
        reference,
      )}`,
      {
        method: "HEAD",
        headers: {
          "User-Agent": UA,
          Accept: MANIFEST_ACCEPT,
          ...ociAuthHeaders(token),
        },
        signal: ctrl.signal,
        cache: "no-store",
      },
    );
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
