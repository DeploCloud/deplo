export const DOCKER_HUB_REGISTRY = "docker.io";

export interface ParsedImageRef {
  registry: string;
  repository: string;
  tag: string;
  digest: string | null;
  isDockerHub: boolean;
  tagImplicit: boolean;
}

function looksLikeHost(component: string): boolean {
  if (component === "localhost") return true;
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(component)) return false;
  return component.includes(".") || component.includes(":");
}

export function parseImageRef(input: string): ParsedImageRef | null {
  const raw = input.trim();
  if (!raw) return null;

  let digest: string | null = null;
  let rest = raw;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
  }

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

  let tag = "";
  let tagImplicit = true;
  const lastColon = path.lastIndexOf(":");
  const lastSlashInPath = path.lastIndexOf("/");
  if (lastColon !== -1 && lastColon > lastSlashInPath) {
    tag = path.slice(lastColon + 1);
    path = path.slice(0, lastColon);
    tagImplicit = false;
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

export function splitForCompletion(input: string): {
  namePart: string;
  tagPart: string | null;
} {
  const raw = input.trim();
  const noDigest = raw.split("@")[0];
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
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
