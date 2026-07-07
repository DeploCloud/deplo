import { test } from "node:test";
import assert from "node:assert/strict";

import { environmentDeployKey, environmentStackName } from "./env-deploy-key";

/**
 * The deploy-key scheme is the load-bearing contract of ADR-0008 Phase 3b:
 * the default environment MUST keep the bare slug (so live stacks are untouched),
 * and non-default environments MUST be collision-proof against every other
 * service's bare key.
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
  // can never equal ANY other service's bare key — even the adversarial case of a
  // service literally slugged `app-preview` sitting next to `app` env `preview`.
  const envKey = environmentStackName("app", { slug: "preview", isDefault: false });
  const adversarialBare = environmentStackName("app-preview", null);
  assert.notEqual(envKey, adversarialBare);
  assert.equal(envKey, "deplo-app__preview");
  assert.equal(adversarialBare, "deplo-app-preview");
  // The only `__` in the key is the environment separator.
  assert.equal((envKey.match(/__/g) ?? []).length, 1);
});
