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

// compensateKeepPerSlug makes `keep_per_slug` safe to send at an agent that IGNORES
// it: the scalar fallback would delete the images an app's rollback depth keeps.
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

// dropUnsupportedScopes strips scopes THIS agent does not implement, so an old host
// still gets the rest. The inventory lists stay: an agent that cannot read them
// ignores them, and an old one still reads live_slugs for its files scope.
export function dropUnsupportedScopes(
  req: DockerCleanupRequest,
  hello: HelloResponse,
): DockerCleanupRequest {
  const caps = hello.capabilities ?? [];
  const scopes = req.scopes.flatMap((s) => {
    const cap = CLEANUP_SCOPE_CAPABILITY[s];
    if (!cap || caps.includes(cap)) return [s];
    // An agent without the anonymous-volume scope still has its buildkit subset.
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

// runAgentCleanup reclaims Docker disk on `serverId`'s host: dial → Hello →
// capability pre-flight → DockerCleanup → close.
export async function runAgentCleanup(
  serverId: string,
  req: DockerCleanupRequest,
): Promise<DockerCleanupResponse> {
  // Resolves only for a provisioned server with un-revoked trust; throws
  // AgentUnreachableError otherwise.
  const target = await resolveTarget(serverId);

  const conn = dial(target);
  try {
    // The agent must SAY it can clean up before we ask it to. An agent too old to
    // know the RPC won't advertise the capability.
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(DOCKER_CLEANUP_CAPABILITY)) {
      throw new AgentCleanupUnsupportedError(CLEANUP_UNSUPPORTED_MESSAGE);
    }
    return await conn.dockerCleanup(
      dropUnsupportedScopes(compensateKeepPerSlug(req, hello), hello),
    );
  } catch (e) {
    // An agent one version behind on the RPC can advertise the capability and still
    // answer UNIMPLEMENTED; mapCleanupUnsupported is idempotent on the throw above.
    throw mapCleanupUnsupported(e);
  } finally {
    conn.close();
  }
}
