import { type YAMLMap } from "../../yaml";

import type { GitRepo } from "../../types/build";
import type { SourceApplication, SourceCompose } from "../model";

import { type Mapped, truncate } from "./source-platform";
import { readComposeDoc, toPlain } from "./compose-yaml";

export type MappedSource =
  | { kind: "git"; repo: GitRepo }
  | { kind: "docker-image"; image: string }
  | { kind: "none" };

const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

const CONNECTED_PROVIDER = new Set(["github", "gitlab", "gitea", "bitbucket"]);

function namedRegistry(image: string): string | null {
  const first = image.split("/")[0] ?? "";
  if (image.split("/").length < 2) return null;
  return /[.:]/.test(first) || first === "localhost" ? first : null;
}

export function composeRegistryNotes(compose: string): string[] {
  const doc = readComposeDoc(compose);
  const services = doc && toPlain((doc.contents as YAMLMap)?.get("services"));
  if (!services || typeof services !== "object") return [];
  const hosts = new Set<string>();
  for (const svc of Object.values(services as Record<string, unknown>)) {
    const image =
      typeof (svc as { image?: unknown })?.image === "string"
        ? ((svc as { image: string }).image ?? "").trim()
        : "";
    const host = image ? namedRegistry(image) : null;
    if (host) hosts.add(host);
  }
  return hosts.size === 0
    ? []
    : [
        `This stack pulls from ${[...hosts].sort().join(", ")}. If any of those images is private, add the registry under Registries - {panel} never exposes the password.`,
      ];
}

export function mapSource(app: SourceApplication): Mapped<MappedSource> {
  const notes: string[] = [];

  if (app.sourceType === "docker") {
    const image = app.dockerImage?.trim();
    if (!image) {
      notes.push("Docker source with no image set on {panel} - pick an image.");
      return { value: { kind: "none" }, notes };
    }
    if (!IMAGE_REF_RE.test(image)) {
      notes.push(
        `Image reference "${truncate(image, 80)}" is not one Deplo accepts - set it by hand.`,
      );
      return { value: { kind: "none" }, notes };
    }
    if (app.registryId || app.registry || app.username || app.registryUrl)
      notes.push(
        "From a private registry. Add it under Registries and reselect it - {panel} never exposes the password.",
      );
    else if (namedRegistry(image))
      notes.push(
        `Pulled from ${namedRegistry(image)}. If that image is private, add the registry under Registries and reselect it.`,
      );
    if (/^(localhost|127\.0\.0\.1|::1|host\.docker\.internal)[:/]/i.test(image))
      notes.push(
        `${image} is in a registry on the {panel} machine. Push it somewhere Deplo can reach, or build from source.`,
      );
    return { value: { kind: "docker-image", image }, notes };
  }

  if (app.sourceType === "drop") {
    notes.push(
      "Its code is an archive somebody uploaded to {panel}, and the API will not hand the file over. Upload it again here.",
    );
    return { value: { kind: "none" }, notes };
  }

  const repo = cloneTarget(app);
  if (!repo) {
    notes.push(
      "Could not work out the repository from {panel} - set the source by hand.",
    );
    return { value: { kind: "none" }, notes };
  }

  if (app.customGitSSHKeyId)
    notes.push(
      "Clones over SSH with a key stored in {panel}. Deplo clones over https, so add a git connection for this host.",
    );
  else if (
    app.gitNeedsCredential ||
    CONNECTED_PROVIDER.has(app.sourceType) ||
    /^(ssh:\/\/|[^/\s]+@[^/\s]+:)/.test(repo.url)
  )
    notes.push(
      `${repo.repo} came from an account connected to {panel}, so no credential came with it. ${
        repo.provider === "github"
          ? "Link a GitHub App under the app's Source settings"
          : "Attach a git connection"
      } if the repository is private - that also turns on auto-deploy.`,
    );

  return {
    value: {
      kind: "git",
      repo: {
        ...repo,
        triggerType: app.triggerType === "tag" ? "tag" : "push",
        watchPaths: (app.watchPaths ?? []).filter((p) => p.trim()),
        submodules: app.enableSubmodules === true,
      },
    },
    notes,
  };
}

export function cloneTarget(
  app: SourceApplication | SourceCompose,
): GitRepo | null {
  const a = app as SourceApplication;
  const host = (raw: string | null | undefined, fallback: string): string => {
    const v = raw?.trim();
    if (!v) return fallback;
    try {
      const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    } catch {
      return fallback;
    }
  };

  switch (app.sourceType) {
    case "github": {
      if (a.owner && a.repository)
        return {
          provider: "github",
          url: `https://github.com/${a.owner}/${a.repository}.git`,
          repo: `${a.owner}/${a.repository}`,
          branch: a.branch?.trim() || "main",
        };
      break;
    }
    case "gitlab": {
      const owner = a.gitlabOwner?.trim();
      const repository = a.gitlabRepository?.trim();
      // gitlabPathNamespace is the FULL project path: appending the repository made it group/repo/repo.git, a 404.
      const path =
        a.gitlabPathNamespace?.trim() ||
        (owner && repository ? `${owner}/${repository}` : "");
      if (path) {
        const origin = host(a.gitlab?.gitlabUrl, "https://gitlab.com");
        return {
          provider: "gitlab",
          url: `${origin}/${path}.git`,
          repo: path,
          branch: a.gitlabBranch?.trim() || "main",
        };
      }
      break;
    }
    case "gitea": {
      if (a.giteaOwner && a.giteaRepository) {
        const origin = host(a.gitea?.giteaUrl, "https://gitea.com");
        return {
          provider: "gitea",
          url: `${origin}/${a.giteaOwner}/${a.giteaRepository}.git`,
          repo: `${a.giteaOwner}/${a.giteaRepository}`,
          branch: a.giteaBranch?.trim() || "main",
        };
      }
      break;
    }
    case "bitbucket": {
      const slug =
        a.bitbucketRepositorySlug?.trim() || a.bitbucketRepository?.trim();
      if (a.bitbucketOwner && slug)
        return {
          provider: "bitbucket",
          url: `https://bitbucket.org/${a.bitbucketOwner}/${slug}.git`,
          repo: `${a.bitbucketOwner}/${slug}`,
          branch: a.bitbucketBranch?.trim() || "main",
        };
      break;
    }
    case "git":
      break;
    default:
      return null;
  }

  const url = a.customGitUrl?.trim();
  if (!url) return null;
  return {
    provider: app.sourceType as GitRepo["provider"],
    url,
    repo: repoNameFromUrl(url),
    branch: a.customGitBranch?.trim() || "main",
  };
}

export function repoNameFromUrl(url: string): string {
  const cleaned = url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^[^/:]+[:/]/, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cleaned;
}
