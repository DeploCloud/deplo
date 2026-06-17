/**
 * Parse a Docker / OCI image reference into its registry, repository, and
 * tag/digest, applying Docker's canonical defaulting rules. Shared by the image
 * autocomplete route and any UI that needs to reason about an image string.
 *
 * Docker's rules for splitting "<maybe-host>/<rest>":
 *  - The first slash-separated component is the registry host ONLY if it looks
 *    like a host: it contains a "." or a ":", or it is exactly "localhost".
 *    Otherwise it is part of the repository path on Docker Hub.
 *  - On Docker Hub, a single-component repo (e.g. "nginx") is the official
 *    image "library/nginx". A two-component repo ("user/app") is used as-is.
 *  - The default registry is "docker.io" (whose real API host is
 *    registry-1.docker.io); the default tag is "latest".
 *  - A reference may pin a digest with "@sha256:..."; a tag and digest can both
 *    be present ("repo:tag@sha256:..."), in which case the digest wins.
 *
 * This is intentionally dependency-free and safe to run on client or server.
 */

export const DOCKER_HUB_REGISTRY = "docker.io";

export interface ParsedImageRef {
  /** Registry host, e.g. "docker.io", "ghcr.io", "registry.gitlab.com". */
  registry: string;
  /**
   * Repository path as the registry's v2 API expects it. For Docker Hub this is
   * always namespaced, so bare "nginx" becomes "library/nginx".
   */
  repository: string;
  /** Explicit or defaulted tag ("latest" when none and no digest given). */
  tag: string;
  /** Digest when pinned with "@sha256:...", else null. */
  digest: string | null;
  /** True when the reference targets Docker Hub (the default registry). */
  isDockerHub: boolean;
  /**
   * True when the user has not yet typed a tag or digest. Lets the UI know it
   * should offer tag completions rather than treat "latest" as chosen.
   */
  tagImplicit: boolean;
}

/** Does the first path component look like a registry host rather than a Hub namespace? */
function looksLikeHost(component: string): boolean {
  if (component === "localhost") return true;
  // A host has a dot (registry.example.com) or a port (host:5000). A bare
  // "library" or "user" has neither and is a Docker Hub namespace.
  return component.includes(".") || component.includes(":");
}

/**
 * Parse an image reference. Tolerant of partial input (e.g. "postgres",
 * "ghcr.io/org/", "nginx:") so it can drive live autocomplete. Returns null
 * only when there is no repository to speak of yet.
 */
export function parseImageRef(input: string): ParsedImageRef | null {
  const raw = input.trim();
  if (!raw) return null;

  // Split off a digest first ("repo:tag@sha256:..." or "repo@sha256:...").
  let digest: string | null = null;
  let rest = raw;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
  }

  // Determine the registry host vs the path. Only split on the first "/".
  let registry = DOCKER_HUB_REGISTRY;
  let path = rest;
  const slash = rest.indexOf("/");
  if (slash !== -1) {
    const first = rest.slice(0, slash);
    if (looksLikeHost(first)) {
      registry = first;
      path = rest.slice(slash + 1);
    }
  }

  // Split a tag off the path's LAST component. A ":" in the registry host was
  // already excluded above (it stays with `registry`), so any ":" here is a tag.
  let tag = "";
  let tagImplicit = true;
  const lastColon = path.lastIndexOf(":");
  const lastSlashInPath = path.lastIndexOf("/");
  if (lastColon !== -1 && lastColon > lastSlashInPath) {
    tag = path.slice(lastColon + 1);
    path = path.slice(0, lastColon);
    tagImplicit = false; // user typed a ":", even if the tag is still empty
  }

  let repository = path;
  const isDockerHub = registry === DOCKER_HUB_REGISTRY;
  if (isDockerHub && repository && !repository.includes("/")) {
    // Bare Hub image -> official "library/" namespace.
    repository = `library/${repository}`;
  }

  if (!repository) return null;

  if (!tag && !digest) tag = "latest";

  return {
    registry,
    repository,
    tag,
    digest,
    isDockerHub,
    tagImplicit: tagImplicit && !digest,
  };
}

/**
 * Split a partial image string into the "repository fragment the user is still
 * typing" and "the tag fragment after a colon", for driving name vs tag
 * completion. Unlike parseImageRef this does no defaulting — it reflects the
 * literal text so the UI can decide which kind of suggestion to show.
 */
export function splitForCompletion(input: string): {
  /** Everything before the tag colon (may include a registry + namespace). */
  namePart: string;
  /** The text after the last tag colon, or null when no tag colon is present. */
  tagPart: string | null;
} {
  const raw = input.trim();
  // Ignore a digest tail for completion purposes.
  const noDigest = raw.split("@")[0];
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  // A colon counts as a tag separator only if it is after the last slash and is
  // not the registry-host port colon (which sits before the first slash).
  const firstSlash = noDigest.indexOf("/");
  const isHostPortColon =
    colon !== -1 && firstSlash !== -1 && colon < firstSlash;
  if (colon > slash && !isHostPortColon) {
    return { namePart: noDigest.slice(0, colon), tagPart: noDigest.slice(colon + 1) };
  }
  return { namePart: noDigest, tagPart: null };
}
