import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const read = (f: string) =>
  readFile(join(process.cwd(), "components/apps", f), "utf8");

/**
 * The last step's button is a rocket labelled Deploy, so it must deploy; the
 * alternative lives in the caret beside it and must NOT.
 */
test("the wizard's last step says what it will actually do", async () => {
  const steps = await Promise.all(
    [
      "new-app-wizard/details-step.tsx",
      "new-app-wizard/configure-step.tsx",
    ].map(read),
  );
  for (const l of steps.join("\n").match(/nextLabel=\{?"?[^\n]*/g) ?? [])
    assert.ok(
      !/Create app/.test(l),
      `the deploy button must not promise a creation it does not do: ${l}`,
    );

  const wizard = await read("new-app-wizard/new-app-wizard.tsx");
  assert.match(
    wizard,
    /onCreateWithoutDeploy=\{\s*isTemplate \? \(\) => deploy\(false\)/,
    "the alternative action must skip the first deployment",
  );
  assert.match(
    wizard,
    /shouldDeploy: startDeployment/,
    "the wizard must carry that choice into the create input",
  );
});
