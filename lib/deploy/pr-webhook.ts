/**
 * What a GitHub `pull_request` delivery MEANS for one app — the preview twin of
 * [git-webhook](./git-webhook.ts), and pure for the same reason: the decision is
 * the part worth testing, and the route around it is plumbing.
 */

/** The fields of a `pull_request` payload this module reads. */
export interface RawPullRequestPayload {
  action?: string;
  number?: number;
  repository?: { full_name?: string };
  installation?: { id?: number };
  pull_request?: {
    number?: number;
    title?: string;
    draft?: boolean;
    merged?: boolean;
    html_url?: string;
    user?: { login?: string };
    head?: {
      ref?: string;
      sha?: string;
      repo?: { full_name?: string; clone_url?: string } | null;
    };
    base?: { ref?: string };
    /** GitHub sends the pull request's CURRENT labels on every delivery. */
    labels?: { name?: string }[];
  };
}

/** One pull request delivery, normalised. */
export interface PullRequestEvent {
  /** The raw GitHub action, verbatim. */
  action: string;
  number: number;
  title: string;
  author: string;
  url: string;
  headBranch: string;
  headSha: string;
  /** `owner/name` of the head repo; "" when the fork has been deleted. */
  headRepo: string;
  headCloneUrl: string;
  /** The repo the App is installed on — what candidate apps are matched against. */
  baseRepo: string;
  baseBranch: string;
  /** The head lives somewhere the operator does not control. */
  isFork: boolean;
  draft: boolean;
  merged: boolean;
  /** The pull request's labels, lower-cased — GitHub matches them that way. */
  labels: string[];
}

/** The app-side facts the decision needs. */
export interface PreviewTriggerConfig {
  /** The branch the app tracks — pull requests must TARGET it. */
  branch: string;
  previewsEnabled: boolean;
  /** Rebuild when the pull request receives a new commit. */
  autoDeploy: boolean;
  /** Build a pull request that is still a draft. */
  buildDrafts: boolean;
  /** A pull request must carry ONE of these. Empty ⇒ no filter. */
  requiredLabels: string[];
}

/** Why a delivery produced nothing. Logged, never silent. */
export type PreviewSkipReason =
  | "previews-off"
  | "base-branch"
  | "draft"
  | "no-head-repo"
  | "action"
  /** The app filters on labels and this pull request carries none of them. */
  | "label"
  /** A new commit landed, but this app only builds previews on request. */
  | "manual-only";

export type PreviewIntent =
  | { kind: "deploy" }
  | { kind: "destroy" }
  | { kind: "ignore"; reason: PreviewSkipReason };

/**
 * Normalise a `pull_request` payload. Returns null when the delivery carries no
 * usable pull request (a malformed body, or one of GitHub's shapes we never
 * subscribed to).
 */
export function parsePullRequestEvent(
  payload: RawPullRequestPayload,
): PullRequestEvent | null {
  const pr = payload.pull_request;
  const number = pr?.number ?? payload.number;
  const baseRepo = payload.repository?.full_name ?? "";
  if (!pr || typeof number !== "number" || !baseRepo) return null;
  const headRepo = pr.head?.repo?.full_name ?? "";
  return {
    action: payload.action ?? "",
    number,
    title: pr.title ?? `Pull request #${number}`,
    author: pr.user?.login ?? "",
    url: pr.html_url ?? "",
    headBranch: pr.head?.ref ?? "",
    headSha: pr.head?.sha ?? "",
    headRepo,
    headCloneUrl: pr.head?.repo?.clone_url ?? "",
    baseRepo,
    baseBranch: pr.base?.ref ?? "",
    // NOT `head.repo.fork`: a pull request opened from an unrelated repository in the
    // same organisation reports `fork: false` and is every bit as untrusted.
    isFork: !headRepo || headRepo !== baseRepo,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
    // Lower-cased at the door so every comparison downstream is a plain
    // `includes` and nobody has to remember that GitHub labels are
    // case-insensitive.
    labels: (pr.labels ?? [])
      .map((l) => (l?.name ?? "").trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * What to do with one delivery, for one app. `closed` destroys FIRST, before any
 * gate. the pull request must TARGET the branch this app tracks.
 */
export function previewIntent(
  cfg: PreviewTriggerConfig,
  ev: PullRequestEvent,
): PreviewIntent {
  if (ev.action === "closed") return { kind: "destroy" };
  if (!cfg.previewsEnabled) return { kind: "ignore", reason: "previews-off" };
  if (ev.baseBranch !== cfg.branch) {
    return { kind: "ignore", reason: "base-branch" };
  }

  // The label gate spans every action, which is why it sits above the action
  // switch: a pull request that loses its last required label must be torn down
  // whichever delivery carried the news.
  const labelled =
    cfg.requiredLabels.length === 0 ||
    ev.labels.some((l) => cfg.requiredLabels.includes(l));
  if (!labelled) {
    return ev.action === "unlabeled"
      ? { kind: "destroy" }
      : { kind: "ignore", reason: "label" };
  }

  if (
    ev.action === "opened" ||
    ev.action === "reopened" ||
    ev.action === "synchronize" ||
    ev.action === "ready_for_review" ||
    // `labeled` builds ONLY for an app that filters on labels: there, the label applied
    // after the pull request opened is the moment it qualifies, and without this it
    // would never build at all.
    (ev.action === "labeled" && cfg.requiredLabels.length > 0)
  ) {
    if (!ev.headRepo) return { kind: "ignore", reason: "no-head-repo" };
    if (ev.draft && !cfg.buildDrafts)
      return { kind: "ignore", reason: "draft" };
    if (ev.action === "synchronize" && !cfg.autoDeploy) {
      return { kind: "ignore", reason: "manual-only" };
    }
    return { kind: "deploy" };
  }
  return { kind: "ignore", reason: "action" };
}
