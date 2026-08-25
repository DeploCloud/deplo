import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appSlugFromDeployKey,
  environmentDeployKey,
  environmentStackName,
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

test("the default environment keeps the bare service slug (zero churn)", () => {
  assert.equal(
    environmentDeployKey("app", { slug: "production", isDefault: true }),
    "app",
  );
  assert.equal(
    environmentStackName("app", { slug: "production", isDefault: true }),
    "deplo-app",
    "the seeded Production stack is byte-identical to the legacy one",
  );
});

test("no environment (legacy top-level service) keeps the bare slug", () => {
  assert.equal(environmentDeployKey("app", null), "app");
  assert.equal(environmentDeployKey("app", undefined), "app");
  assert.equal(environmentStackName("app", null), "deplo-app");
});

test("a non-default environment gets a __-suffixed key", () => {
  assert.equal(
    environmentDeployKey("app", { slug: "preview", isDefault: false }),
    "app__preview",
  );
  assert.equal(
    environmentStackName("app", { slug: "staging", isDefault: false }),
    "deplo-app__staging",
  );
});

test("__ separator makes non-default keys collision-proof across services", () => {
  // A slug is `[a-z0-9-]` and can NEVER contain `__`, so a non-default env key
  // can never equal ANY other app's bare key — even the adversarial case of an
  // app literally slugged `app-preview` sitting next to `app` env `preview`.
  const envKey = environmentStackName("app", {
    slug: "preview",
    isDefault: false,
  });
  const adversarialBare = environmentStackName("app-preview", null);
  assert.notEqual(envKey, adversarialBare);
  assert.equal(envKey, "deplo-app__preview");
  assert.equal(adversarialBare, "deplo-app-preview");
  // The only `__` in the key is the environment separator.
  assert.equal((envKey.match(/__/g) ?? []).length, 1);
});

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

test("a deploy key resolves back to its app slug without a query", () => {
  assert.equal(appSlugFromDeployKey("blog"), "blog");
  assert.equal(appSlugFromDeployKey(previewDeployKey("blog", 42)), "blog");
  assert.equal(
    appSlugFromDeployKey(
      environmentDeployKey("blog", { slug: "staging", isDefault: false }),
    ),
    "blog",
  );
  // A slug that merely LOOKS suffixed is still returned whole.
  assert.equal(appSlugFromDeployKey("blog-pr-42"), "blog-pr-42");
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

test("the reserved preview suffix shape is what keeps environments out of the way", () => {
  // An Environment slugged `pr-42` would produce the exact key a preview of the
  // same app owns; `PREVIEW_SUFFIX_RE` is the guard the environment create path
  // uses to refuse it.
  assert.equal(PREVIEW_SUFFIX_RE.test("pr-42"), true);
  assert.equal(PREVIEW_SUFFIX_RE.test("preview"), false);
  assert.equal(PREVIEW_SUFFIX_RE.test("pr-"), false);
  assert.equal(
    environmentDeployKey("blog", { slug: "pr-42", isDefault: false }),
    previewDeployKey("blog", 42),
    "which is precisely why the environment create path must refuse this slug",
  );
});
