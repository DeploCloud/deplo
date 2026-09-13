import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * "Create without deploying" reaches the wizard as `deploy=false`, and the last
 * step's button is a rocket labelled Deploy. A button that names an action it
 * will not take is worse than no shortcut at all.
 */
test("the wizard's last step says what it will actually do", async () => {
  const wizard = await readFile(
    join(process.cwd(), "components/apps/new-app-wizard.tsx"),
    "utf8",
  );
  const labels = wizard.match(/nextLabel=\{[^}]*"Deploy"[^}]*\}/g) ?? [];
  assert.ok(labels.length > 0, "the deploy labels moved");
  for (const l of labels)
    assert.match(l, /shouldDeploy/, `an unconditional Deploy label: ${l}`);
  // The rocket is the same promise as the word.
  assert.ok(!/\n\s+deploy\n/.test(wizard), "the rocket must follow it too");
});
