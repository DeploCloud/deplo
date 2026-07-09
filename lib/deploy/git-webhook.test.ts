import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePushEvent,
  shouldAutoDeploy,
  pathMatchesGlob,
  pathMatchesAnyGlob,
  type RepoTriggerConfig,
} from "./git-webhook";

/* ---- parsePushEvent -------------------------------------------------- */

test("parsePushEvent: branch push strips refs/heads and unions changed files", () => {
  const ev = parsePushEvent({
    ref: "refs/heads/main",
    commits: [
      { added: ["a.ts"], modified: ["b.ts"] },
      { removed: ["a.ts"] },
    ],
    head_commit: { message: "x", modified: ["c.ts"] },
  });
  assert.equal(ev.isTag, false);
  assert.equal(ev.refName, "main");
  assert.equal(ev.deleted, false);
  assert.deepEqual([...ev.changedPaths].sort(), ["a.ts", "b.ts", "c.ts"]);
});

test("parsePushEvent: tag push is flagged and short-named", () => {
  const ev = parsePushEvent({ ref: "refs/tags/v1.2.0", head_commit: null });
  assert.equal(ev.isTag, true);
  assert.equal(ev.refName, "v1.2.0");
  assert.deepEqual(ev.changedPaths, []);
});

test("parsePushEvent: a delete push is marked deleted", () => {
  const ev = parsePushEvent({ ref: "refs/heads/old", deleted: true });
  assert.equal(ev.deleted, true);
});

/* ---- shouldAutoDeploy: trigger type ---------------------------------- */

const pushCfg: RepoTriggerConfig = {
  branch: "main",
  triggerType: "push",
  watchPaths: [],
};
const tagCfg: RepoTriggerConfig = {
  branch: "main",
  triggerType: "tag",
  watchPaths: [],
};

test("push trigger: deploys on a push to the tracked branch only", () => {
  assert.equal(
    shouldAutoDeploy(pushCfg, parsePushEvent({ ref: "refs/heads/main" })),
    true,
  );
  assert.equal(
    shouldAutoDeploy(pushCfg, parsePushEvent({ ref: "refs/heads/dev" })),
    false,
  );
  // A tag push must NOT fire a push-triggered service.
  assert.equal(
    shouldAutoDeploy(pushCfg, parsePushEvent({ ref: "refs/tags/v1" })),
    false,
  );
});

test("tag trigger: deploys on any new tag, never on a branch push", () => {
  assert.equal(
    shouldAutoDeploy(tagCfg, parsePushEvent({ ref: "refs/tags/v9" })),
    true,
  );
  assert.equal(
    shouldAutoDeploy(tagCfg, parsePushEvent({ ref: "refs/heads/main" })),
    false,
  );
});

test("a ref deletion never deploys, whatever the trigger", () => {
  assert.equal(
    shouldAutoDeploy(
      pushCfg,
      parsePushEvent({ ref: "refs/heads/main", deleted: true }),
    ),
    false,
  );
  assert.equal(
    shouldAutoDeploy(
      tagCfg,
      parsePushEvent({ ref: "refs/tags/v1", deleted: true }),
    ),
    false,
  );
});

/* ---- shouldAutoDeploy: watch paths ----------------------------------- */

test("watch paths gate a push: only a matching change deploys", () => {
  const cfg: RepoTriggerConfig = {
    branch: "main",
    triggerType: "push",
    watchPaths: ["apps/web/**", "package.json"],
  };
  assert.equal(
    shouldAutoDeploy(
      cfg,
      parsePushEvent({ ref: "refs/heads/main", head_commit: { modified: ["apps/web/page.tsx"] } }),
    ),
    true,
  );
  assert.equal(
    shouldAutoDeploy(
      cfg,
      parsePushEvent({ ref: "refs/heads/main", head_commit: { modified: ["docs/readme.md"] } }),
    ),
    false,
  );
});

test("watch paths fail open when the delivery carries no file list", () => {
  const cfg: RepoTriggerConfig = {
    branch: "main",
    triggerType: "tag",
    watchPaths: ["apps/web/**"],
  };
  // An annotated-tag push has no commits/head_commit files → deploy anyway.
  assert.equal(
    shouldAutoDeploy(cfg, parsePushEvent({ ref: "refs/tags/v2", head_commit: null })),
    true,
  );
});

/* ---- glob matching --------------------------------------------------- */

test("pathMatchesGlob: literal patterns are file-or-directory-prefix matches", () => {
  assert.equal(pathMatchesGlob("src", "src"), true);
  assert.equal(pathMatchesGlob("src/app.ts", "src"), true);
  assert.equal(pathMatchesGlob("srcextra/x", "src"), false); // not a path boundary
  assert.equal(pathMatchesGlob("package.json", "package.json"), true);
  assert.equal(pathMatchesGlob("apps/package.json", "package.json"), false);
});

test("pathMatchesGlob: * stays within a segment, ** crosses separators", () => {
  assert.equal(pathMatchesGlob("README.md", "*.md"), true);
  assert.equal(pathMatchesGlob("docs/x.md", "*.md"), false);
  assert.equal(pathMatchesGlob("docs/x.md", "**/*.md"), true);
  assert.equal(pathMatchesGlob("x.md", "**/*.md"), true); // **/ matches zero dirs
  assert.equal(pathMatchesGlob("apps/web/page.tsx", "apps/web/**"), true);
  assert.equal(pathMatchesGlob("apps/api/page.tsx", "apps/web/**"), false);
});

test("pathMatchesGlob: **/ is anchored to a path boundary (no partial-segment match)", () => {
  // The leading **/ must consume WHOLE segments — it may not swallow a partial
  // filename, so a sibling that merely shares the suffix does not match.
  assert.equal(pathMatchesGlob("config.json", "**/config.json"), true); // zero dirs
  assert.equal(pathMatchesGlob("a/b/config.json", "**/config.json"), true);
  assert.equal(pathMatchesGlob("myconfig.json", "**/config.json"), false);
  assert.equal(pathMatchesGlob("barfoo", "**/foo"), false);
  assert.equal(pathMatchesGlob("a/x/b", "a/**/b"), true);
  assert.equal(pathMatchesGlob("a/b", "a/**/b"), true);
});

test("pathMatchesAnyGlob: leading ./ and / are normalised away", () => {
  assert.equal(pathMatchesAnyGlob("./apps/web/x", ["apps/web/**"]), true);
  assert.equal(pathMatchesAnyGlob("apps/web/x", ["/apps/web/**"]), true);
  assert.equal(pathMatchesAnyGlob("a", []), false);
});
