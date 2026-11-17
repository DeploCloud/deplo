import { test } from "node:test";
import assert from "node:assert/strict";

import { isDottedRoute } from "./shell-frame";

test("the grids that drag and select are dotted, nothing else", () => {
  for (const p of ["/", "/apps", "/storage", "/settings/servers"])
    assert.equal(isDottedRoute(p), true, p);
  assert.equal(isDottedRoute("/settings/servers", "view=list"), true);
  assert.equal(
    isDottedRoute("/settings/servers", "cluster=clu_1"),
    false,
    "inside a cluster the servers are a table",
  );

  for (const p of [
    "/apps/web",
    "/apps/web/domains",
    "/storage/databases/db_1",
    "/storage/databases/db_1/settings/connection",
    "/servers",
    "/deployments",
    "/templates",
    "/settings/servers/srv_1",
  ])
    assert.equal(isDottedRoute(p), false, p);
});
