import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePullRequestEvent,
  previewIntent,
  type RawPullRequestPayload,
} from "./pr-webhook";

/**
 * The preview decision is the part worth testing: which pull request deliveries
 * build, which tear down, and which are deliberately ignored. Mirrors
 * git-webhook.test.ts in shape, since it mirrors git-webhook.ts in design.
 */

const BASE = "acme/blog";

function payload(over: Partial<RawPullRequestPayload["pull_request"]> = {}, action = "opened"): RawPullRequestPayload {
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
        repo: { full_name: BASE, clone_url: "https://github.com/acme/blog.git" },
      },
      base: { ref: "main" },
      ...over,
    },
  };
}

const CFG = { branch: "main", previewsEnabled: true };

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
    parsePullRequestEvent({ action: "opened", repository: { full_name: BASE } }),
    null,
  );
});

test("a head in another repository is a fork, whatever GitHub's fork flag says", () => {
  // A pull request from an unrelated repo in the same org reports `fork: false`
  // and is every bit as untrusted. The only question is whether the head lives
  // somewhere the operator controls.
  const ev = parsePullRequestEvent(
    payload({ head: { ref: "patch", sha: "d3", repo: { full_name: "mallory/blog" } } }),
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
  for (const action of ["opened", "reopened", "synchronize", "ready_for_review"]) {
    const ev = parsePullRequestEvent(payload({}, action))!;
    assert.deepEqual(previewIntent(CFG, ev), { kind: "deploy" }, action);
  }
});

test("closed tears down BEFORE any gate is consulted", () => {
  // A preview created while previews were on must still be destroyed after they
  // are switched off, or after the app is repointed at another branch —
  // otherwise the switch silently strands containers on the host.
  const ev = parsePullRequestEvent(payload({}, "closed"))!;
  assert.deepEqual(previewIntent(CFG, ev), { kind: "destroy" });
  assert.deepEqual(
    previewIntent({ branch: "main", previewsEnabled: false }, ev),
    { kind: "destroy" },
  );
  assert.deepEqual(
    previewIntent({ branch: "release/v2", previewsEnabled: true }, ev),
    { kind: "destroy" },
  );
});

test("a merged pull request is just a closed one", () => {
  const ev = parsePullRequestEvent(payload({ merged: true }, "closed"))!;
  assert.equal(ev.merged, true);
  assert.deepEqual(previewIntent(CFG, ev), { kind: "destroy" });
});

test("previews off means nothing builds", () => {
  const ev = parsePullRequestEvent(payload())!;
  assert.deepEqual(previewIntent({ branch: "main", previewsEnabled: false }, ev), {
    kind: "ignore",
    reason: "previews-off",
  });
});

test("a pull request must TARGET the branch the app tracks", () => {
  // This is what makes one repository backing three apps behave: an app
  // deployed from `main` must not build pull requests aimed at `release/v2`.
  const ev = parsePullRequestEvent(payload({ base: { ref: "release/v2" } }))!;
  assert.deepEqual(previewIntent(CFG, ev), {
    kind: "ignore",
    reason: "base-branch",
  });
  assert.deepEqual(
    previewIntent({ branch: "release/v2", previewsEnabled: true }, ev),
    { kind: "deploy" },
  );
});

test("drafts wait for ready_for_review", () => {
  const draft = parsePullRequestEvent(payload({ draft: true }))!;
  assert.deepEqual(previewIntent(CFG, draft), { kind: "ignore", reason: "draft" });
  const ready = parsePullRequestEvent(payload({ draft: false }, "ready_for_review"))!;
  assert.deepEqual(previewIntent(CFG, ready), { kind: "deploy" });
});

test("converting back to a draft does NOT tear the preview down", () => {
  // Pulling a URL out from under someone because the author ticked a box is a
  // surprise with no upside — one container is cheaper than that.
  const ev = parsePullRequestEvent(payload({ draft: true }, "converted_to_draft"))!;
  assert.deepEqual(previewIntent(CFG, ev), { kind: "ignore", reason: "action" });
});

test("the chatty actions are ignored, not acted on", () => {
  for (const action of [
    "edited",
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
