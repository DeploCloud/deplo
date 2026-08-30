// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePullRequestEvent,
  previewIntent,
  type PreviewTriggerConfig,
  type RawPullRequestPayload,
} from "./pr-webhook";

/**
 * The preview decision is the part worth testing: which pull request deliveries
 * build, which tear down, and which are deliberately ignored. Mirrors
 * git-webhook.test.ts in shape, since it mirrors git-webhook.ts in design.
 */

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

/** The defaults an app gets before anybody opens the settings page. */
const CFG: PreviewTriggerConfig = {
  branch: "main",
  previewsEnabled: true,
  autoDeploy: true,
  buildDrafts: false,
  requiredLabels: [],
};

/** CFG with one thing changed - the shape most of these tests want. */
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
  // A pull request from an unrelated repo in the same org reports `fork: false`
  // and is every bit as untrusted. The only question is whether the head lives
  // somewhere the operator controls.
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
  // A preview created while previews were on must still be destroyed after they
  // are switched off, or after the app is repointed at another branch,
  // otherwise the switch silently strands containers on the host.
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
  // This is what makes one repository backing three apps behave: an app
  // deployed from `main` must not build pull requests aimed at `release/v2`.
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
  // Pulling a URL out from under someone because the author ticked a box is a
  // surprise with no upside - one container is cheaper than that.
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

/* ------------------------------------------------------------------ */
/* The settings that gate a build                                      */
/* ------------------------------------------------------------------ */

test("the label filter: a pull request must carry one of the app's labels", () => {
  const c = cfg({ requiredLabels: ["preview", "deploy-me"] });

  const none = parsePullRequestEvent(payload({ labels: [{ name: "bug" }] }))!;
  assert.deepEqual(previewIntent(c, none), { kind: "ignore", reason: "label" });

  // One is enough - the labels are alternatives, not a checklist.
  const one = parsePullRequestEvent(
    payload({ labels: [{ name: "bug" }, { name: "deploy-me" }] }),
  )!;
  assert.deepEqual(previewIntent(c, one), { kind: "deploy" });

  // GitHub labels are case-insensitive and so is the filter.
  const shouty = parsePullRequestEvent(
    payload({ labels: [{ name: "PREVIEW" }] }),
  )!;
  assert.deepEqual(previewIntent(c, shouty), { kind: "deploy" });

  // No filter ⇒ every pull request qualifies, labels or not.
  const unlabelled = parsePullRequestEvent(payload({ labels: [] }))!;
  assert.deepEqual(previewIntent(CFG, unlabelled), { kind: "deploy" });
});

test("applying the label is what builds; removing the last one tears down", () => {
  const c = cfg({ requiredLabels: ["preview"] });

  // Without this, a label applied AFTER the pull request opened would never
  // build: `labeled` used to fall through to the chatty-action ignore.
  const applied = parsePullRequestEvent(
    payload({ labels: [{ name: "preview" }] }, "labeled"),
  )!;
  assert.deepEqual(previewIntent(c, applied), { kind: "deploy" });

  // Removing the label is the explicit "that's enough, free the slot" gesture -
  // the only teardown besides `closed`.
  const removed = parsePullRequestEvent(payload({ labels: [] }, "unlabeled"))!;
  assert.deepEqual(previewIntent(c, removed), { kind: "destroy" });

  // Removing ONE of several leaves the preview alone AND does not rebuild it:
  // the pull request still qualifies, so nothing that matters changed.
  const stillQualifies = parsePullRequestEvent(
    payload({ labels: [{ name: "preview" }] }, "unlabeled"),
  )!;
  assert.deepEqual(previewIntent(c, stillQualifies), {
    kind: "ignore",
    reason: "action",
  });

  // With NO filter a label is chatter, not a trigger - an app that doesn't
  // filter must not burn a build every time somebody triages a pull request.
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

test("auto-deploy off stops a new commit, but not opening the pull request", () => {
  const c = cfg({ autoDeploy: false });
  const push = parsePullRequestEvent(payload({}, "synchronize"))!;
  assert.deepEqual(previewIntent(c, push), {
    kind: "ignore",
    reason: "manual-only",
  });
  // The FIRST build still happens: "manual only" is about refreshing, not about
  // never getting a preview at all.
  for (const action of ["opened", "reopened", "ready_for_review"]) {
    const ev = parsePullRequestEvent(payload({}, action))!;
    assert.deepEqual(previewIntent(c, ev), { kind: "deploy" }, action);
  }
});

test("closed still tears down whatever the new gates say", () => {
  // Same reasoning as the original: a preview that exists must be destroyable,
  // or turning a gate on strands containers nobody can see.
  const ev = parsePullRequestEvent(payload({ labels: [] }, "closed"))!;
  const c = cfg({ requiredLabels: ["preview"], autoDeploy: false });
  assert.deepEqual(previewIntent(c, ev), { kind: "destroy" });
});
