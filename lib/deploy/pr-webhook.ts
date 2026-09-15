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
    labels?: { name?: string }[];
  };
}

export interface PullRequestEvent {
  action: string;
  number: number;
  title: string;
  author: string;
  url: string;
  headBranch: string;
  headSha: string;
  headRepo: string;
  headCloneUrl: string;
  baseRepo: string;
  baseBranch: string;
  isFork: boolean;
  draft: boolean;
  merged: boolean;
  labels: string[];
}

export interface PreviewTriggerConfig {
  branch: string;
  previewsEnabled: boolean;
  autoDeploy: boolean;
  buildDrafts: boolean;
  requiredLabels: string[];
}

export type PreviewSkipReason =
  | "previews-off"
  | "base-branch"
  | "draft"
  | "no-head-repo"
  | "action"
  | "label";

export type PreviewIntent =
  | { kind: "deploy" }
  | { kind: "destroy" }
  | { kind: "sync" }
  | { kind: "ignore"; reason: PreviewSkipReason };

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
    isFork: !headRepo || headRepo !== baseRepo,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
    labels: (pr.labels ?? [])
      .map((l) => (l?.name ?? "").trim().toLowerCase())
      .filter(Boolean),
  };
}

export function previewIntent(
  cfg: PreviewTriggerConfig,
  ev: PullRequestEvent,
): PreviewIntent {
  if (ev.action === "closed") return { kind: "destroy" };
  if (!cfg.previewsEnabled) return { kind: "ignore", reason: "previews-off" };
  if (ev.baseBranch !== cfg.branch) {
    return ev.action === "edited"
      ? { kind: "destroy" }
      : { kind: "ignore", reason: "base-branch" };
  }

  const labelled =
    cfg.requiredLabels.length === 0 ||
    ev.labels.some((l) => cfg.requiredLabels.includes(l));
  if (!labelled) {
    return ev.action === "unlabeled"
      ? { kind: "destroy" }
      : { kind: "ignore", reason: "label" };
  }

  if (ev.action === "edited") return { kind: "sync" };

  if (
    ev.action === "opened" ||
    ev.action === "reopened" ||
    ev.action === "synchronize" ||
    ev.action === "ready_for_review" ||
    (ev.action === "labeled" && cfg.requiredLabels.length > 0)
  ) {
    if (!ev.headRepo) return { kind: "ignore", reason: "no-head-repo" };
    if (ev.draft && !cfg.buildDrafts)
      return { kind: "ignore", reason: "draft" };
    if (ev.action === "synchronize" && !cfg.autoDeploy) return { kind: "sync" };
    return { kind: "deploy" };
  }
  return { kind: "ignore", reason: "action" };
}
