import { test } from "node:test";
import assert from "node:assert/strict";

import { isDottedRoute } from "./shell-frame";

test("the grids that drag and select are dotted, nothing else", () => {
  for (const p of ["/", "/apps", "/storage"])
    assert.equal(isDottedRoute(p), true, p);

  for (const p of [
    "/apps/web",
    "/apps/web/domains",
    "/storage/databases/db_1",
    "/storage/databases/db_1/settings/connection",
    "/servers",
    "/deployments",
    "/templates",
    "/settings/servers",
  ])
    assert.equal(isDottedRoute(p), false, p);
});
