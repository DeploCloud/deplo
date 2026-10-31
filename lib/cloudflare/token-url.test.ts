import { test } from "node:test";
import assert from "node:assert/strict";

import { CLOUDFLARE_TOKEN_URL } from "./token-url";

test("the Create one link prefills every permission the tunnel needs", () => {
  const url = new URL(CLOUDFLARE_TOKEN_URL);
  assert.equal(
    url.origin + url.pathname,
    "https://dash.cloudflare.com/profile/api-tokens",
  );
  assert.deepEqual(JSON.parse(url.searchParams.get("permissionGroupKeys")!), [
    { key: "argotunnel", type: "edit" },
    { key: "dns", type: "edit" },
    { key: "zone", type: "read" },
  ]);
  assert.equal(url.searchParams.get("accountId"), "*");
  assert.equal(url.searchParams.get("zoneId"), "all");
});
