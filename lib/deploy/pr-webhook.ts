/**
 * What a GitHub `pull_request` delivery MEANS for one app — the preview twin of
 * [git-webhook](./git-webhook.ts), and pure for the same reason: the decision is
 * the part worth testing, and the route around it is plumbing.
 *
 * No imports, no store, no fetch. The route parses, asks `previewIntent` once
 * per candidate app, and does what it is told.
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
}

/** The app-side facts the decision needs. */
export interface PreviewTriggerConfig {
  /** The branch the app tracks — pull requests must TARGET it. */
  branch: string;
  previewsEnabled: boolean;
}

/** Why a delivery produced nothing. Logged, never silent. */
export type PreviewSkipReason =
  | "previews-off"
  | "base-branch"
  | "draft"
  | "no-head-repo"
  | "action";

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
    // NOT `head.repo.fork`: a pull request opened from an unrelated repository
    // in the same organisation reports `fork: false` and is every bit as
    // untrusted. The only question that matters is whether the head lives
    // somewhere the operator controls.
    isFork: !headRepo || headRepo !== baseRepo,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
  };
}

/**
 * What to do with one delivery, for one app. The ORDER of the checks is the
 * design:
 *
 *  1. `closed` destroys FIRST, before any gate. A preview created while
 *     previews were on must still be torn down after they are switched off, or
 *     after the app is repointed at another branch — otherwise the switch
 *     silently strands containers. Destroying is always safe: the route only
 *     acts on a preview row that exists.
 *  2. previews off ⇒ nothing.
 *  3. the pull request must TARGET the branch this app tracks. This is what
 *     makes "one repository backing three apps" behave: an app deployed from
 *     `main` must not build pull requests aimed at `release/v2`. It is also the
 *     one place a user can be silently surprised, which is why the empty state
 *     names the branch out loud.
 *  4. drafts are skipped until `ready_for_review`. A work-in-progress branch is
 *     not worth a container, and the manual "Deploy a pull request" action
 *     covers the exception — an action instead of a setting.
 *  5. everything else (`edited`, `labeled`, `assigned`, `converted_to_draft`, …)
 *     is ignored. In particular `converted_to_draft` does NOT tear down: pulling
 *     a URL out from under someone because the author ticked a box is a surprise
 *     with no upside.
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
  if (
    ev.action === "opened" ||
    ev.action === "reopened" ||
    ev.action === "synchronize" ||
    ev.action === "ready_for_review"
  ) {
    if (!ev.headRepo) return { kind: "ignore", reason: "no-head-repo" };
    if (ev.draft) return { kind: "ignore", reason: "draft" };
    return { kind: "deploy" };
  }
  return { kind: "ignore", reason: "action" };
}
