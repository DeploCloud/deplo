import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appSlugFromDeployKey,
  isSuffixedDeployKey,
  PREVIEW_SUFFIX_RE,
  prNumberFromDeployKey,
  previewDeployKey,
  stackName,
} from "./deploy-key";

/**
 * The deploy-key scheme is the load-bearing contract of ADR-0008 Phase 3b: the
 * default environment MUST keep the bare slug (so live stacks are untouched), and
 * non-default environments MUST be collision-proof against every other app's bare
 */

/* ------------------------------------------------------------------ */
/* Pull request previews (ADR-0014)                                    */
/* ------------------------------------------------------------------ */

test("a preview key is the app slug plus a pr-<n> suffix", () => {
  assert.equal(previewDeployKey("blog", 42), "blog__pr-42");
  assert.equal(stackName(previewDeployKey("blog", 42)), "deplo-blog__pr-42");
});

test("a preview key can never collide with another app's production stack", () => {
  // The adversarial case: an app literally slugged `blog-pr-42` sitting next to
  // pull request 42 of `blog`. A slug is `[a-z0-9-]` so it can never contain the
  // `__` separator, which is what makes the two stacks provably distinct.
  const preview = stackName(previewDeployKey("blog", 42));
  const adversarialApp = stackName("blog-pr-42");
  assert.notEqual(preview, adversarialApp);
  assert.equal(preview, "deplo-blog__pr-42");
  assert.equal(adversarialApp, "deplo-blog-pr-42");
});

test("two previews collide only when they are the same app and the same PR", () => {
  const seen = new Map<string, string>();
  for (const slug of ["blog", "blog-pr", "blog-pr-1", "shop", "a"]) {
    for (const pr of [1, 2, 42, 100]) {
      const key = previewDeployKey(slug, pr);
      const id = `${slug}#${pr}`;
      const prev = seen.get(key);
      assert.equal(prev, undefined, `${key} collided: ${prev} vs ${id}`);
      seen.set(key, id);
    }
  }
});

test("suffixed keys are recognisable, bare ones are not", () => {
  assert.equal(isSuffixedDeployKey("blog"), false);
  assert.equal(isSuffixedDeployKey("blog-pr-42"), false);
  assert.equal(isSuffixedDeployKey(previewDeployKey("blog", 42)), true);
});

test("only a pr-<n> suffix reads back as a pull request number", () => {
  assert.equal(prNumberFromDeployKey(previewDeployKey("blog", 42)), 42);
  assert.equal(prNumberFromDeployKey("blog"), null);
  assert.equal(prNumberFromDeployKey("blog__staging"), null);
  assert.equal(prNumberFromDeployKey("blog__pr-x"), null);
});
