import { test } from "node:test";
import assert from "node:assert/strict";

import { querySuffix } from "./legacy-redirect";

test("querySuffix carries a deep link's query to the page it moved to", () => {
  assert.equal(
    querySuffix({ agent: "claude-code", step: "permissions", preset: "agent" }),
    "?agent=claude-code&step=permissions&preset=agent",
  );
  assert.equal(querySuffix({ tag: ["a", "b"] }), "?tag=a&tag=b");
  assert.equal(querySuffix({}), "");
});
