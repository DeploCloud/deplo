import { test } from "node:test";
import assert from "node:assert/strict";

import { isDottedRoute } from "./shell-frame";

test("the resource canvases are dotted, the reading surfaces are not", () => {
  for (const p of [
    "/",
    "/apps",
    "/apps/web",
    "/apps/web/domains",
    "/storage",
    "/storage/databases/db_1/settings/connection",
    "/servers",
  ])
    assert.equal(isDottedRoute(p), true, p);

  for (const p of [
    "/deployments",
    "/activity",
    "/logs",
    "/monitoring",
    "/members",
    "/variables",
    "/templates",
    "/settings/servers",
  ])
    assert.equal(isDottedRoute(p), false, p);
});
