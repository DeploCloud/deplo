import { test } from "node:test";
import assert from "node:assert/strict";

import { panelNameFor } from "./runner-state";

test("the run report names the source panel", () => {
  assert.equal(
    panelNameFor({ platform: "coolify", sourceUrl: "https://c.example" }),
    "Coolify",
  );
  assert.equal(
    panelNameFor({ platform: "dokploy", sourceUrl: "https://d.example" }),
    "Dokploy",
  );
});
