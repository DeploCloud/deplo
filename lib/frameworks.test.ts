import { test } from "node:test";
import assert from "node:assert/strict";

import { buildConfigFor } from "./frameworks";

/**
 * Since migration 0147 an empty command means "run nothing here", so the default
 * a NEW app is born with has to be null. Getting this wrong makes every new app
 * skip its own install and build, and nothing else in the suite would notice.
 */
test("a new app's commands are null, never empty strings", () => {
  const build = buildConfigFor();
  for (const key of [
    "installCommand",
    "buildCommand",
    "outputDirectory",
    "startCommand",
  ] as const) {
    assert.equal(
      build[key],
      null,
      `${key} must be null ("work it out"), not "" ("run nothing")`,
    );
  }
});

test("an explicit empty command survives the defaults", () => {
  assert.equal(buildConfigFor({ buildCommand: "" }).buildCommand, "");
});
