import { test } from "node:test";
import assert from "node:assert/strict";

import { newAppHref } from "./overview-links";

test("a suggested repository opens the wizard with its integration, and only what is set", () => {
  assert.equal(
    newAppHref(null, {
      repo: "acme/shop",
      branch: "main",
      installation: "ghi_1",
      connection: undefined,
    }),
    "/new?repo=acme%2Fshop&branch=main&installation=ghi_1",
  );
  assert.equal(
    newAppHref({ folderId: "fld_1" }, { source: "upload" }),
    "/new?folder=fld_1&source=upload",
  );
});
