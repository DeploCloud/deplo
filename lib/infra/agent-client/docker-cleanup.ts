import "server-only";

import {
  CleanupScope,
  type DockerCleanupRequest,
  type DockerCleanupResponse,
  type HelloResponse,
} from "../../agent/gen/agent";
import { connectAgent } from "./connect";
import {
  AgentCleanupUnsupportedError,
  CLEANUP_UNSUPPORTED_MESSAGE,
  mapCleanupUnsupported,
} from "./errors";
import {
  CLEANUP_KEEP_PER_SLUG_CAPABILITY,
  CLEANUP_SCOPE_CAPABILITY,
  CLEANUP_SAFE_PRUNE_CAPABILITY,
  DOCKER_CLEANUP_CAPABILITY,
} from "./hello-capabilities";

// An agent that ignores keep_per_slug falls back on the scalar and deletes the images rollback keeps.
export function compensateKeepPerSlug(
  req: DockerCleanupRequest,
  hello: HelloResponse,
): DockerCleanupRequest {
  const perSlug = Object.values(req.keepPerSlug ?? {});
  if (perSlug.length === 0) return req;
  if (hello.capabilities?.includes(CLEANUP_KEEP_PER_SLUG_CAPABILITY))
    return req;
  return {
    ...req,
    keepImagesPerApp: Math.max(req.keepImagesPerApp, ...perSlug),
    keepPerSlug: {},
  };
}

export function dropUnsupportedScopes(
  req: DockerCleanupRequest,
  hello: HelloResponse,
): DockerCleanupRequest {
  const caps = hello.capabilities ?? [];
  const scopes = [
    ...new Set(
      req.scopes.flatMap((s) => {
        if (
          s === CleanupScope.CLEANUP_SCOPE_ORPHAN_VOLUMES &&
          caps.includes("cleanup.orphan-volumes") &&
          !caps.includes(CLEANUP_SAFE_PRUNE_CAPABILITY)
        ) {
          return [CleanupScope.CLEANUP_SCOPE_ORPHAN_BUILDKIT_CACHE, s];
        }
        const cap = CLEANUP_SCOPE_CAPABILITY[s];
        if (!cap || caps.includes(cap)) return [s];
        if (s === CleanupScope.CLEANUP_SCOPE_ORPHAN_VOLUMES)
          return [CleanupScope.CLEANUP_SCOPE_ORPHAN_BUILDKIT_CACHE];
        return [];
      }),
    ),
  ];
  if (
    scopes.every((s, i) => s === req.scopes[i]) &&
    scopes.length === req.scopes.length
  )
    return req;
  return { ...req, scopes };
}

export async function runAgentCleanup(
  serverId: string,
  req: DockerCleanupRequest,
): Promise<DockerCleanupResponse> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(DOCKER_CLEANUP_CAPABILITY)) {
      throw new AgentCleanupUnsupportedError(CLEANUP_UNSUPPORTED_MESSAGE);
    }
    const sent = dropUnsupportedScopes(
      compensateKeepPerSlug(req, hello),
      hello,
    );
    return normalizeCleanupResponse(req, sent, await conn.dockerCleanup(sent));
  } catch (e) {
    throw mapCleanupUnsupported(e);
  } finally {
    conn.close();
  }
}

export function normalizeCleanupResponse(
  requested: DockerCleanupRequest,
  sent: DockerCleanupRequest,
  response: DockerCleanupResponse,
): DockerCleanupResponse {
  const results = [...response.results];
  for (const scope of requested.scopes) {
    const legacyVolume =
      scope === CleanupScope.CLEANUP_SCOPE_ORPHAN_VOLUMES &&
      !sent.scopes.includes(scope) &&
      results.some(
        (r) => r.scope === CleanupScope.CLEANUP_SCOPE_ORPHAN_BUILDKIT_CACHE,
      );
    if (results.some((r) => r.scope === scope) || legacyVolume) continue;
    results.push({
      scope,
      reclaimedBytes: 0,
      itemsRemoved: 0,
      items: [],
      skipped: true,
      error: sent.scopes.includes(scope)
        ? "The server agent did not report this cleanup scope"
        : "Update the server agent to enable this cleanup safely",
    });
  }
  const failures = results
    .filter((r) => r.error || r.skipped)
    .map((r) => r.error || "A cleanup scope was skipped");
  return {
    ...response,
    results,
    ok: response.ok && failures.length === 0,
    error: response.error || [...new Set(failures)].join("; "),
  };
}
