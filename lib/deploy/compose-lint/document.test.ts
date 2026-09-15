import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertComposeWithinLimits,
  composeHasInlineEnvValues,
} from "./document";

test("a compose that expands past reason, or is simply huge, is refused at save", () => {
  const bomb = [
    "x-a0: &a0 [x, x, x, x, x, x, x, x, x, x]",
    "x-a1: &a1 [*a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0, *a0]",
    "x-a2: &a2 [*a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1, *a1]",
    "x-a3: &a3 [*a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2, *a2]",
    "x-a4: &a4 [*a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3, *a3]",
    "x-a5: &a5 [*a4, *a4, *a4, *a4, *a4, *a4, *a4, *a4, *a4, *a4]",
    "services:",
    "  web:",
    "    image: nginx",
    "    labels: *a5",
    "",
  ].join("\n");
  assert.throws(() => assertComposeWithinLimits(bomb), /too many entries/);
  assert.throws(
    () =>
      assertComposeWithinLimits(
        "services:\n  web:\n    image: nginx\n" + "#".repeat(300 * 1024),
      ),
    /too large/,
  );
  assertComposeWithinLimits(
    "x-common: &common\n  restart: always\nservices:\n  web:\n    <<: *common\n    image: nginx\n",
  );
});

test("inline environment values are seen in both forms, pass-throughs are not", () => {
  assert.equal(
    composeHasInlineEnvValues(
      "services:\n  a:\n    environment:\n      - KEY=v\n",
    ),
    true,
  );
  assert.equal(
    composeHasInlineEnvValues(
      "services:\n  a:\n    environment:\n      KEY: v\n",
    ),
    true,
  );
  assert.equal(
    composeHasInlineEnvValues(
      "services:\n  a:\n    environment:\n      - KEY\n",
    ),
    false,
  );
  assert.equal(
    composeHasInlineEnvValues(
      "services:\n  a:\n    environment:\n      KEY:\n",
    ),
    false,
  );
  assert.equal(
    composeHasInlineEnvValues("services:\n  a:\n    image: x\n"),
    false,
  );
});
