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
  /** The repo the App is installed on - what candidate apps are matched against. */
  baseRepo: string;
  baseBranch: string;
  /** The head lives somewhere the operator does not control. */
  isFork: boolean;
  draft: boolean;
  merged: boolean;
  /** The pull request's labels, lower-cased - GitHub matches them that way. */
  labels: string[];
}

/** The app-side facts the decision needs. */
export interface PreviewTriggerConfig {
  /** The branch the app tracks - pull requests must TARGET it. */
  branch: string;
  previewsEnabled: boolean;
  /** Rebuild when the pull request receives a new commit. */
  autoDeploy: boolean;
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
  | "label";

export type PreviewIntent =
  | { kind: "deploy" }
  | { kind: "destroy" }
  /** Refresh the list (head, title, approval) without building - an unrecorded head keeps a stale approval. */
  | { kind: "sync" }
  | { kind: "ignore"; reason: PreviewSkipReason };

/** Normalise a `pull_request` payload. Null when the delivery carries no usable pull request. */
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
    // NOT `head.repo.fork`: an unrelated repo in the same org reports `fork: false` and is as untrusted.
    isFork: !headRepo || headRepo !== baseRepo,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
    labels: (pr.labels ?? [])
      .map((l) => (l?.name ?? "").trim().toLowerCase())
      .filter(Boolean),
  };
}

/** What to do with one delivery, for one app. `closed` destroys FIRST, before any gate. */
export function previewIntent(
  cfg: PreviewTriggerConfig,
  ev: PullRequestEvent,
): PreviewIntent {
  if (ev.action === "closed") return { kind: "destroy" };
  if (!cfg.previewsEnabled) return { kind: "ignore", reason: "previews-off" };
  if (ev.baseBranch !== cfg.branch) {
    // `edited` is also how GitHub reports a retarget.
    return ev.action === "edited"
      ? { kind: "destroy" }
      : { kind: "ignore", reason: "base-branch" };
  }

  // The label gate spans every action: losing the last required label must tear down whichever delivery brought it.
  const labelled =
    cfg.requiredLabels.length === 0 ||
    ev.labels.some((l) => cfg.requiredLabels.includes(l));
  if (!labelled) {
    return ev.action === "unlabeled"
      ? { kind: "destroy" }
      : { kind: "ignore", reason: "label" };
  }

  // A title edit changes nothing on the host, but the list must not lie.
  if (ev.action === "edited") return { kind: "sync" };

  if (
    ev.action === "opened" ||
    ev.action === "reopened" ||
    ev.action === "synchronize" ||
    ev.action === "ready_for_review" ||
    // `labeled` builds ONLY where labels filter: it is the moment the pull request qualifies.
    (ev.action === "labeled" && cfg.requiredLabels.length > 0)
  ) {
    if (!ev.headRepo) return { kind: "ignore", reason: "no-head-repo" };
    if (ev.draft && !cfg.buildDrafts)
      return { kind: "ignore", reason: "draft" };
    // Manual-only apps still RECORD the new head, and that a fork's commit is unapproved.
    if (ev.action === "synchronize" && !cfg.autoDeploy) return { kind: "sync" };
    return { kind: "deploy" };
  }
  return { kind: "ignore", reason: "action" };
}
