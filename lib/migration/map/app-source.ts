import { type YAMLMap } from "../../yaml";

import type { GitRepo } from "../../types/build";
import type { SourceApplication, SourceCompose } from "../model";

import { type Mapped, truncate } from "./source-platform";
import { readComposeDoc, toPlain } from "./compose-yaml";

/** A source Deplo can deploy, or null when the app has to be rebuilt by hand. */
export type MappedSource =
  | { kind: "git"; repo: GitRepo }
  | { kind: "docker-image"; image: string }
  | { kind: "none" };

const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

/** Source kinds that mean "cloned through an account the panel had connected",
 *  which is the only shape that may need a credential Deplo does not have. */
const CONNECTED_PROVIDER = new Set(["github", "gitlab", "gitea", "bitbucket"]);

/** The registry a reference names, or null for Docker Hub (a host has a dot or a
 *  colon, or is `localhost`). */
function namedRegistry(image: string): string | null {
  const first = image.split("/")[0] ?? "";
  if (image.split("/").length < 2) return null;
  return /[.:]/.test(first) || first === "localhost" ? first : null;
}

/**
 * The registries a stack's images name. A compose stack never goes through
 * `mapSource`, so an image behind a login was carried across in silence and the
 * deploy failed on the pull with nothing in the report to explain it.
 */
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

/**
 * Where the app's code comes from.
 */
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
    // A private pull can be configured two ways over there: a registry ENTITY, or a
    // username/password/URL typed straight onto the application (`saveDockerProvider`).
    if (app.registryId || app.registry || app.username || app.registryUrl)
      notes.push(
        "From a private registry. Add it under Registries and reselect it - {panel} never exposes the password.",
      );
    // No credential on the row, but the image names a registry of its own:
    // {panel} may have been pulling with a machine-wide `docker login` nothing
    // here can see, and the deploy then failed on the image saying nothing.
    else if (namedRegistry(image))
      notes.push(
        `Pulled from ${namedRegistry(image)}. If that image is private, add the registry under Registries and reselect it.`,
      );
    // A registry running ON the source host. The reference is perfectly valid over
    // there and means nothing here, and the failure it produces later ("pull
    // access denied") points at the image rather than at the move.
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

  // Only when the SOURCE needed one. Said for every git app, this was the most
  // frequent line in the report and false for most of them: a public repository
  // clones here exactly as it cloned there, and the count of things needing a
  // person made the whole migration look like manual work that was not.
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

/** The `owner/name`, branch and https URL for whichever provider is configured. */
export function cloneTarget(
  app: SourceApplication | SourceCompose,
): GitRepo | null {
  const a = app as SourceApplication;
  // Origin AND path: a self-hosted GitLab or Gitea behind a reverse proxy lives at
  // `https://acme.com/gitlab`, and dropping the prefix clones a 404.
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
      // `gitlabPathNamespace` is the FULL project path, not the namespace its name
      // suggests: Dokploy clones `<host>/<gitlabPathNamespace>.git`. Appending the
      // repository to it produced `group/repo/repo.git`, a 404 on every app.
      const owner = a.gitlabOwner?.trim();
      const repository = a.gitlabRepository?.trim();
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

  // A panel that NAMES the provider but hands over the finished address instead of
  // its parts (Coolify keeps the host on the source and joins the two itself). Taken
  // as given: rebuilding it from parts would lose a self-hosted host.
  const url = a.customGitUrl?.trim();
  if (!url) return null;
  return {
    provider: app.sourceType as GitRepo["provider"],
    url,
    repo: repoNameFromUrl(url),
    branch: a.customGitBranch?.trim() || "main",
  };
}

/** `owner/name` out of any clone URL, https or scp-style. */
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
