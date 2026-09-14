export const DOCKER_HUB_REGISTRY = "docker.io";

export interface ParsedImageRef {
  /** Registry host, e.g. "docker.io", "ghcr.io", "registry.gitlab.com". */
  registry: string;
  // Path as the registry's v2 API expects it; on the Hub always namespaced ("nginx" -> "library/nginx").
  repository: string;
  /** Explicit or defaulted tag ("latest" when none and no digest given). */
  tag: string;
  /** Digest when pinned with "@sha256:...", else null. */
  digest: string | null;
  isDockerHub: boolean;
  // No tag or digest typed yet, so the UI offers completions instead of treating "latest" as chosen.
  tagImplicit: boolean;
}

// Does the first path component look like a registry host rather than a Hub namespace?
function looksLikeHost(component: string): boolean {
  if (component === "localhost") return true;
  // Hostname characters only: "?", "#", "@" and friends must never reach a URL as a host.
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(component)) return false;
  // A host has a dot or a port; a bare "library" or "user" has neither and is a Hub namespace.
  return component.includes(".") || component.includes(":");
}

// Tolerant of partial input ("ghcr.io/org/", "nginx:") to drive live autocomplete; null only when there is no repository yet.
export function parseImageRef(input: string): ParsedImageRef | null {
  const raw = input.trim();
  if (!raw) return null;

  // Digest comes off first, so the tag split below cannot see "repo:tag@sha256:...".
  let digest: string | null = null;
  let rest = raw;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
  }

  // Registry host vs path: split on the FIRST "/" only.
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

  // The host's ":port" already left with `registry` above, so any ":" after the last "/" is a tag.
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

// Splits a partial image string into name vs tag fragment, for driving completion.
export function splitForCompletion(input: string): {
  /** Everything before the tag colon (may include a registry + namespace). */
  namePart: string;
  /** The text after the last tag colon, or null when no tag colon is present. */
  tagPart: string | null;
} {
  const raw = input.trim();
  const noDigest = raw.split("@")[0];
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  // A colon is a tag separator only after the last slash: before the first one it is the host's port.
  const firstSlash = noDigest.indexOf("/");
  const isHostPortColon =
    colon !== -1 && firstSlash !== -1 && colon < firstSlash;
  if (colon > slash && !isHostPortColon) {
    return {
      namePart: noDigest.slice(0, colon),
      tagPart: noDigest.slice(colon + 1),
    };
  }
  return { namePart: noDigest, tagPart: null };
}
