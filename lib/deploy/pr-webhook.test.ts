import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePullRequestEvent,
  previewIntent,
  type PreviewTriggerConfig,
  type RawPullRequestPayload,
} from "./pr-webhook";

const BASE = "acme/blog";

function payload(
  over: Partial<RawPullRequestPayload["pull_request"]> = {},
  action = "opened",
): RawPullRequestPayload {
  return {
    action,
    repository: { full_name: BASE },
    installation: { id: 99 },
    pull_request: {
      number: 42,
      title: "Add dark mode",
      draft: false,
      html_url: "https://github.com/acme/blog/pull/42",
      user: { login: "octocat" },
      head: {
        ref: "feat/dark-mode",
        sha: "abc1234",
        repo: {
          full_name: BASE,
          clone_url: "https://github.com/acme/blog.git",
        },
      },
      base: { ref: "main" },
      ...over,
    },
  };
}

const CFG: PreviewTriggerConfig = {
  branch: "main",
  previewsEnabled: true,
  autoDeploy: true,
  buildDrafts: false,
  requiredLabels: [],
};

const cfg = (
  over: Partial<PreviewTriggerConfig> = {},
): PreviewTriggerConfig => ({
  ...CFG,
  ...over,
});

test("a same-repo pull request parses into the facts a preview needs", () => {
  const ev = parsePullRequestEvent(payload())!;
  assert.equal(ev.number, 42);
  assert.equal(ev.title, "Add dark mode");
  assert.equal(ev.author, "octocat");
  assert.equal(ev.headBranch, "feat/dark-mode");
  assert.equal(ev.headSha, "abc1234");
  assert.equal(ev.baseRepo, BASE);
  assert.equal(ev.baseBranch, "main");
  assert.equal(ev.isFork, false);
});

test("a payload with no pull request is refused rather than guessed at", () => {
  assert.equal(parsePullRequestEvent({ action: "opened" }), null);
  assert.equal(
    parsePullRequestEvent({
      action: "opened",
      repository: { full_name: BASE },
    }),
    null,
  );
});

test("a head in another repository is a fork, whatever GitHub's fork flag says", () => {
  // An unrelated repo in the same org reports `fork: false` and is every bit as untrusted.
  const ev = parsePullRequestEvent(
    payload({
      head: { ref: "patch", sha: "d3", repo: { full_name: "mallory/blog" } },
    }),
  )!;
  assert.equal(ev.isFork, true);
  assert.equal(ev.headRepo, "mallory/blog");
});

test("a deleted head repository still parses, and is treated as a fork", () => {
  const ev = parsePullRequestEvent(
    payload({ head: { ref: "gone", sha: "d3", repo: null } }),
  )!;
  assert.equal(ev.headRepo, "");
  assert.equal(ev.isFork, true);
  assert.deepEqual(previewIntent(CFG, ev), {
    kind: "ignore",
    reason: "no-head-repo",
  });
});

test("opened, reopened, synchronize and ready_for_review all build", () => {
  for (const action of [
    "opened",
    "reopened",
    "synchronize",
    "ready_for_review",
  ]) {
    const ev = parsePullRequestEvent(payload({}, action))!;
    assert.deepEqual(previewIntent(CFG, ev), { kind: "deploy" }, action);
  }
});

test("closed tears down BEFORE any gate is consulted", () => {
  const ev = parsePullRequestEvent(payload({}, "closed"))!;
  assert.deepEqual(previewIntent(CFG, ev), { kind: "destroy" });
  assert.deepEqual(previewIntent(cfg({ previewsEnabled: false }), ev), {
    kind: "destroy",
  });
  assert.deepEqual(previewIntent(cfg({ branch: "release/v2" }), ev), {
    kind: "destroy",
  });
});

test("a merged pull request is just a closed one", () => {
  const ev = parsePullRequestEvent(payload({ merged: true }, "closed"))!;
  assert.equal(ev.merged, true);
  assert.deepEqual(previewIntent(CFG, ev), { kind: "destroy" });
});

test("previews off means nothing builds", () => {
  const ev = parsePullRequestEvent(payload())!;
  assert.deepEqual(previewIntent(cfg({ previewsEnabled: false }), ev), {
    kind: "ignore",
    reason: "previews-off",
  });
});

test("a pull request must TARGET the branch the app tracks", () => {
  const ev = parsePullRequestEvent(payload({ base: { ref: "release/v2" } }))!;
  assert.deepEqual(previewIntent(CFG, ev), {
    kind: "ignore",
    reason: "base-branch",
  });
  assert.deepEqual(previewIntent(cfg({ branch: "release/v2" }), ev), {
    kind: "deploy",
  });
});

test("drafts wait for ready_for_review", () => {
  const draft = parsePullRequestEvent(payload({ draft: true }))!;
  assert.deepEqual(previewIntent(CFG, draft), {
    kind: "ignore",
    reason: "draft",
  });
  const ready = parsePullRequestEvent(
    payload({ draft: false }, "ready_for_review"),
  )!;
  assert.deepEqual(previewIntent(CFG, ready), { kind: "deploy" });
});

test("converting back to a draft does NOT tear the preview down", () => {
  const ev = parsePullRequestEvent(
    payload({ draft: true }, "converted_to_draft"),
  )!;
  assert.deepEqual(previewIntent(CFG, ev), {
    kind: "ignore",
    reason: "action",
  });
});

test("the chatty actions are ignored, not acted on", () => {
  for (const action of [
    "labeled",
    "unlabeled",
    "assigned",
    "review_requested",
    "synchronize_failed",
    "enqueued",
  ]) {
    const ev = parsePullRequestEvent(payload({}, action))!;
    assert.deepEqual(
      previewIntent(CFG, ev),
      { kind: "ignore", reason: "action" },
      action,
    );
  }
});

test("the label filter: a pull request must carry one of the app's labels", () => {
  const c = cfg({ requiredLabels: ["preview", "deploy-me"] });

  const none = parsePullRequestEvent(payload({ labels: [{ name: "bug" }] }))!;
  assert.deepEqual(previewIntent(c, none), { kind: "ignore", reason: "label" });

  const one = parsePullRequestEvent(
    payload({ labels: [{ name: "bug" }, { name: "deploy-me" }] }),
  )!;
  assert.deepEqual(previewIntent(c, one), { kind: "deploy" });

  // GitHub labels are case-insensitive and so is the filter.
  const shouty = parsePullRequestEvent(
    payload({ labels: [{ name: "PREVIEW" }] }),
  )!;
  assert.deepEqual(previewIntent(c, shouty), { kind: "deploy" });

  const unlabelled = parsePullRequestEvent(payload({ labels: [] }))!;
  assert.deepEqual(previewIntent(CFG, unlabelled), { kind: "deploy" });
});

test("applying the label is what builds; removing the last one tears down", () => {
  const c = cfg({ requiredLabels: ["preview"] });

  const applied = parsePullRequestEvent(
    payload({ labels: [{ name: "preview" }] }, "labeled"),
  )!;
  assert.deepEqual(previewIntent(c, applied), { kind: "deploy" });

  const removed = parsePullRequestEvent(payload({ labels: [] }, "unlabeled"))!;
  assert.deepEqual(previewIntent(c, removed), { kind: "destroy" });

  const stillQualifies = parsePullRequestEvent(
    payload({ labels: [{ name: "preview" }] }, "unlabeled"),
  )!;
  assert.deepEqual(previewIntent(c, stillQualifies), {
    kind: "ignore",
    reason: "action",
  });

  const chatter = parsePullRequestEvent(
    payload({ labels: [{ name: "bug" }] }, "labeled"),
  )!;
  assert.deepEqual(previewIntent(CFG, chatter), {
    kind: "ignore",
    reason: "action",
  });
});

test("build drafts is opt-in, and only changes the draft answer", () => {
  const draft = parsePullRequestEvent(payload({ draft: true }))!;
  assert.deepEqual(previewIntent(CFG, draft), {
    kind: "ignore",
    reason: "draft",
  });
  assert.deepEqual(previewIntent(cfg({ buildDrafts: true }), draft), {
    kind: "deploy",
  });
});

test("auto-deploy off records a new commit without building it", () => {
  const c = cfg({ autoDeploy: false });
  const push = parsePullRequestEvent(payload({}, "synchronize"))!;
  // Never `ignore`: a fork's approval has to be re-asked for the commit nobody reviewed.
  assert.deepEqual(previewIntent(c, push), { kind: "sync" });
  for (const action of ["opened", "reopened", "ready_for_review"]) {
    const ev = parsePullRequestEvent(payload({}, action))!;
    assert.deepEqual(previewIntent(c, ev), { kind: "deploy" }, action);
  }
});

test("a title edit refreshes the facts and builds nothing", () => {
  const ev = parsePullRequestEvent(payload({ title: "Renamed" }, "edited"))!;
  assert.deepEqual(previewIntent(CFG, ev), { kind: "sync" });
  assert.deepEqual(previewIntent(cfg({ requiredLabels: ["preview"] }), ev), {
    kind: "ignore",
    reason: "label",
  });
});

test("retargeting the pull request off the tracked branch tears its preview down", () => {
  const ev = parsePullRequestEvent(
    payload({ base: { ref: "develop" } }, "edited"),
  )!;
  assert.deepEqual(previewIntent(CFG, ev), { kind: "destroy" });
  const push = parsePullRequestEvent(
    payload({ base: { ref: "develop" } }, "synchronize"),
  )!;
  assert.deepEqual(previewIntent(CFG, push), {
    kind: "ignore",
    reason: "base-branch",
  });
});

test("closed still tears down whatever the new gates say", () => {
  const ev = parsePullRequestEvent(payload({ labels: [] }, "closed"))!;
  const c = cfg({ requiredLabels: ["preview"], autoDeploy: false });
  assert.deepEqual(previewIntent(c, ev), { kind: "destroy" });
});
