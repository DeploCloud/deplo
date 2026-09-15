import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("the wizard's last step says what it will actually do", async () => {
  const steps = await Promise.all(
    ["details-step.tsx", "configure-step.tsx"].map((f) =>
      readFile(
        join(process.cwd(), "components/apps/new-app-wizard", f),
        "utf8",
      ),
    ),
  );
  const wizard = steps.join("\n");
  const labels = wizard.match(/nextLabel=\{[^}]*"Deploy"[^}]*\}/g) ?? [];
  assert.ok(labels.length > 0, "the deploy labels moved");
  for (const l of labels)
    assert.match(l, /shouldDeploy/, `an unconditional Deploy label: ${l}`);
  assert.ok(!/\n\s+deploy\n/.test(wizard), "the rocket must follow it too");
});
