import type { GitProviderId } from "../types";

/**
 * What each git host has to let Deplo do, in that host's own words. ONE list per
 * provider, used to request the access, to check it, and to tell the user what to
 * tick - so the three can never drift apart.
 * https://deplo.build/docs/guides/git-providers
 */

export interface AccessRequirement {
  /**
   * The key a granted set is matched against. GitHub spells a permission
   * `<name>:<level>` and an event `event:<name>`; the others use the scope name
   * the provider prints.
   */
  key: string;
  /** The provider's OWN label, so it reads like the screen that has to be fixed. */
  label: string;
  /** What stops working without it. One line, no Docker, no jargon. */
  unlocks: string;
  /** `previews` is only ever reported for a repo that uses pull request previews. */
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

/** Every requirement, per provider. A plain git server asks for nothing. */
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

/** What a provider must allow, for the checklist. `previews` adds the optional half. */
export function requiredAccess(
  provider: GitProviderId | "github",
  opts: { previews?: boolean } = {},
): AccessRequirement[] {
  return (PROVIDER_ACCESS[provider] ?? []).filter(
    (r) => r.feature === "core" || opts.previews,
  );
}

/**
 * What is required but not granted. An empty `granted` set is a real answer
 * (nothing is allowed); `null` means the provider does not report its scopes, and
 * then nothing is missing - a checklist is honest, an accusation is not.
 */
export function missingAccess(
  provider: GitProviderId | "github",
  granted: ReadonlySet<string> | null,
  opts: { previews?: boolean } = {},
): AccessRequirement[] {
  if (!granted) return [];
  return requiredAccess(provider, opts).filter((r) => !granted.has(r.key));
}

/** The scopes line the connect dialog prints, derived rather than restated. */
export function tokenScopesLine(provider: GitProviderId | "github"): string {
  return requiredAccess(provider)
    .map((r) => r.label)
    .join(", ");
}

/* ------------------------------------------------------------------ */
/* Readers: what a provider REPORTS, expanded to the keys it satisfies */
/* ------------------------------------------------------------------ */

/**
 * The requirement keys a stored scope line covers, or null when the provider
 * reported nothing. Null is what keeps a checklist from becoming an accusation.
 */
export function grantedFromScopes(
  provider: GitProviderId | "github",
  tokenScopes: string,
): ReadonlySet<string> | null {
  const scopes = tokenScopes.split(" ").filter(Boolean);
  if (scopes.length === 0) return null;
  return provider === "gitlab" ? gitlabGranted(scopes) : new Set(scopes);
}

/** GitHub's levels are cumulative: `write` also satisfies `read`. */
const GITHUB_LEVELS = ["read", "write", "admin"];

/** The keys a GitHub App's declared permissions + events actually cover. */
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

/** The keys a GitLab token's scopes cover. `api` is the superset of the read ones. */
export function gitlabGranted(scopes: string[]): Set<string> {
  const out = new Set(scopes);
  if (out.has("api")) {
    out.add("read_api");
    out.add("read_repository");
    out.add("write_repository");
  }
  return out;
}

/** The permissions + events a GitHub App manifest must ask for. */
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
