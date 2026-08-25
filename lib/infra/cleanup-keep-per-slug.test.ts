import { test } from "node:test";
import assert from "node:assert/strict";

import { compensateKeepPerSlug, dropUnsupportedScopes } from "./agent-client";
import { CleanupScope, ContractVersion } from "../agent/gen/agent";
import type { DockerCleanupRequest, HelloResponse } from "../agent/gen/agent";

/**
 * Per-app image retention across an agent that predates it. `keep_per_slug` is how
 * an app's ROLLBACK DEPTH reaches its host.
 */

const hello = (caps: string[]): HelloResponse => ({
  contractVersion: ContractVersion.CONTRACT_VERSION_V1,
  agentVersion: "1.25.0",
  dockerAvailable: true,
  dockerVersion: "27",
  capabilities: caps,
  traefikRunning: true,
  hostArch: "amd64",
});

const req = (
  over: Partial<DockerCleanupRequest> = {},
): DockerCleanupRequest => ({
  scopes: [CleanupScope.CLEANUP_SCOPE_UNUSED_APP_IMAGES],
  dryRun: false,
  minAgeHours: 24,
  keepImagesPerApp: 1,
  keepPerSlug: {},
  liveSlugs: [],
  ...over,
});

test("a capable agent gets the map untouched", async () => {
  const input = req({ keepPerSlug: { web: 4, api: 2 } });
  const out = compensateKeepPerSlug(input, hello(["cleanup.keep-per-slug"]));
  assert.deepEqual(out.keepPerSlug, { web: 4, api: 2 });
  assert.equal(out.keepImagesPerApp, 1);
});

test("an old agent gets the map dropped and the scalar raised to its deepest value", async () => {
  const out = compensateKeepPerSlug(
    req({ keepPerSlug: { web: 4, api: 2 } }),
    hello(["docker-cleanup"]),
  );
  // 4, not 1: over-keeping for `api` costs disk on a host nobody has updated yet.
  // Under-keeping for `web` would delete the image its rollback needs, and that
  // is unrecoverable - Deplo pushes to no registry.
  assert.equal(out.keepImagesPerApp, 4);
  assert.deepEqual(out.keepPerSlug, {});
});

test("the compensation never LOWERS the scalar an old agent was already sent", async () => {
  const out = compensateKeepPerSlug(
    req({ keepImagesPerApp: 9, keepPerSlug: { web: 2 } }),
    hello(["docker-cleanup"]),
  );
  assert.equal(out.keepImagesPerApp, 9);
});

test("a request with no map is passed through by either agent, unchanged", async () => {
  const input = req();
  assert.equal(compensateKeepPerSlug(input, hello(["docker-cleanup"])), input);
  assert.equal(
    compensateKeepPerSlug(input, hello(["cleanup.keep-per-slug"])),
    input,
  );
});

test("an agent that advertises no capabilities at all is treated as old", async () => {
  const out = compensateKeepPerSlug(
    req({ keepPerSlug: { web: 6 } }),
    hello([]),
  );
  assert.equal(out.keepImagesPerApp, 6);
  assert.deepEqual(out.keepPerSlug, {});
});

/* ------------------------------------------------------------------ */
/* dropUnsupportedScopes — the opposite failure mode                    */
/* ------------------------------------------------------------------ */

/**
 * An unknown SCOPE is not ignored the way an unknown field is: the agent answers
 * INVALID_ARGUMENT, which fails the whole sweep. So an operator who ticks the new
 * scope must not lose the other four on every host that is a version behind.
 */
test("an old agent keeps the scopes it knows and loses only the new one", () => {
  const out = dropUnsupportedScopes(
    req({
      scopes: [
        CleanupScope.CLEANUP_SCOPE_BUILD_CACHE,
        CleanupScope.CLEANUP_SCOPE_LEFTOVER_APP_FILES,
      ],
      liveSlugs: ["web", "db-shop"],
    }),
    hello(["docker-cleanup"]),
  );
  assert.deepEqual(out.scopes, [CleanupScope.CLEANUP_SCOPE_BUILD_CACHE]);
  // And the inventory goes with it - it means nothing without its scope.
  assert.deepEqual(out.liveSlugs, []);
});

test("a capable agent gets the scope and the list untouched", () => {
  const input = req({
    scopes: [CleanupScope.CLEANUP_SCOPE_LEFTOVER_APP_FILES],
    liveSlugs: ["web"],
  });
  const out = dropUnsupportedScopes(input, hello(["cleanup.leftover-files"]));
  assert.equal(out, input);
});
