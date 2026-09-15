import "server-only";

import {
  CleanupScope,
  type DockerCleanupRequest,
  type DockerCleanupResponse,
  type HelloResponse,
} from "../../agent/gen/agent";
import { dial } from "./connect";
import {
  AgentCleanupUnsupportedError,
  CLEANUP_UNSUPPORTED_MESSAGE,
  mapCleanupUnsupported,
} from "./errors";
import {
  CLEANUP_KEEP_PER_SLUG_CAPABILITY,
  CLEANUP_SCOPE_CAPABILITY,
  DOCKER_CLEANUP_CAPABILITY,
} from "./hello-capabilities";
import { resolveTarget } from "./mtls-channel";

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
  const scopes = req.scopes.flatMap((s) => {
    const cap = CLEANUP_SCOPE_CAPABILITY[s];
    if (!cap || caps.includes(cap)) return [s];
    if (s === CleanupScope.CLEANUP_SCOPE_ORPHAN_VOLUMES)
      return [CleanupScope.CLEANUP_SCOPE_ORPHAN_BUILDKIT_CACHE];
    return [];
  });
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
  const target = await resolveTarget(serverId);

  const conn = dial(target);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(DOCKER_CLEANUP_CAPABILITY)) {
      throw new AgentCleanupUnsupportedError(CLEANUP_UNSUPPORTED_MESSAGE);
    }
    return await conn.dockerCleanup(
      dropUnsupportedScopes(compensateKeepPerSlug(req, hello), hello),
    );
  } catch (e) {
    throw mapCleanupUnsupported(e);
  } finally {
    conn.close();
  }
}
