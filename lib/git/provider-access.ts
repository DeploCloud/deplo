import type { GitProviderId } from "../types/git";

export interface AccessRequirement {
  key: string;
  label: string;
  unlocks: string;
  feature: "core" | "previews";
}

const GITHUB: AccessRequirement[] = [
  {
    key: "metadata:read",
    label: "Metadata: Read-only",
    unlocks: "see your repositories at all",
    feature: "core",
  },
  {
    key: "contents:read",
    label: "Contents: Read-only",
    unlocks: "clone your code to build it",
    feature: "core",
  },
  {
    key: "event:push",
    label: "Subscribe to event: Push",
    unlocks: "deploy automatically when you push",
    feature: "core",
  },
  {
    key: "pull_requests:write",
    label: "Pull requests: Read and write",
    unlocks: "post the preview address on the pull request",
    feature: "previews",
  },
  {
    key: "event:pull_request",
    label: "Subscribe to event: Pull request",
    unlocks: "build a preview when a pull request opens",
    feature: "previews",
  },
];

const GITLAB: AccessRequirement[] = [
  {
    key: "read_repository",
    label: "read_repository",
    unlocks: "clone your code to build it",
    feature: "core",
  },
  {
    key: "api",
    label: "api",
    unlocks: "list your projects and register the push webhook",
    feature: "core",
  },
];

const BITBUCKET: AccessRequirement[] = [
  {
    key: "repository",
    label: "Repositories: Read",
    unlocks: "list and clone your repositories",
    feature: "core",
  },
  {
    key: "webhook",
    label: "Webhooks: Read and write",
    unlocks: "deploy automatically when you push",
    feature: "core",
  },
];

const GITEA: AccessRequirement[] = [
  {
    key: "read:repository",
    label: "read:repository",
    unlocks: "list and clone your repositories",
    feature: "core",
  },
  {
    key: "write:repository",
    label: "write:repository",
    unlocks: "register the push webhook so a push deploys",
    feature: "core",
  },
];

export const PROVIDER_ACCESS: Record<
  GitProviderId | "github",
  AccessRequirement[]
> = {
  github: GITHUB,
  gitlab: GITLAB,
  bitbucket: BITBUCKET,
  gitea: GITEA,
  git: [],
};

export function requiredAccess(
  provider: GitProviderId | "github",
  opts: { previews?: boolean } = {},
): AccessRequirement[] {
  return (PROVIDER_ACCESS[provider] ?? []).filter(
    (r) => r.feature === "core" || opts.previews,
  );
}

export function missingAccess(
  provider: GitProviderId | "github",
  granted: ReadonlySet<string> | null,
  opts: { previews?: boolean } = {},
): AccessRequirement[] {
  if (!granted) return [];
  return requiredAccess(provider, opts).filter((r) => !granted.has(r.key));
}

export function tokenScopesLine(provider: GitProviderId | "github"): string {
  return requiredAccess(provider)
    .map((r) => r.label)
    .join(", ");
}

export function grantedFromScopes(
  provider: GitProviderId | "github",
  tokenScopes: string,
): ReadonlySet<string> | null {
  const scopes = tokenScopes.split(" ").filter(Boolean);
  if (scopes.length === 0) return null;
  return provider === "gitlab" ? gitlabGranted(scopes) : new Set(scopes);
}

const GITHUB_LEVELS = ["read", "write", "admin"];

export function githubGranted(
  permissions: Record<string, string>,
  events: string[],
): Set<string> {
  const out = new Set<string>();
  for (const [name, level] of Object.entries(permissions)) {
    const i = GITHUB_LEVELS.indexOf(level);
    for (const l of GITHUB_LEVELS.slice(0, i + 1)) out.add(`${name}:${l}`);
  }
  for (const e of events) out.add(`event:${e}`);
  return out;
}

export function gitlabGranted(scopes: string[]): Set<string> {
  const out = new Set(scopes);
  if (out.has("api")) {
    out.add("read_api");
    out.add("read_repository");
    out.add("write_repository");
  }
  return out;
}

export function githubManifestAccess(): {
  permissions: Record<string, string>;
  events: string[];
} {
  const permissions: Record<string, string> = {};
  const events: string[] = [];
  for (const r of GITHUB) {
    if (r.key.startsWith("event:")) events.push(r.key.slice("event:".length));
    else {
      const [name, level] = r.key.split(":");
      permissions[name!] = level!;
    }
  }
  return { permissions, events };
}
