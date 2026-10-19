import { test } from "node:test";
import assert from "node:assert/strict";

import { panelNameFor } from "./runner-state";

test("the run report names the source panel, including another Deplo", () => {
  assert.equal(
    panelNameFor({ platform: "deplo", sourceUrl: "https://old.example.com" }),
    "Deplo at old.example.com",
  );
  assert.equal(
    panelNameFor({ platform: "coolify", sourceUrl: "https://c.example" }),
    "Coolify",
  );
  assert.equal(
    panelNameFor({ platform: "dokploy", sourceUrl: "https://d.example" }),
    "Dokploy",
  );
});
