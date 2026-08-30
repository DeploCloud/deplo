import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeUpCommandPreview,
  parseComposeUpArgs,
  validateComposeUpArgs,
} from "./compose-args";

/**
 * The app's extra `docker compose up` flags. Two things have to hold: what the
 * settings page previews is exactly what the host runs, and nothing that would
 * repoint the command at another stack can ever be stored.
 */

test("flags are split into argv tokens, whitespace and all", () => {
  assert.deepEqual(parseComposeUpArgs("--pull always"), ["--pull", "always"]);
  assert.deepEqual(
    parseComposeUpArgs("  --wait   --timeout=60 \n --no-deps "),
    ["--wait", "--timeout=60", "--no-deps"],
  );
  for (const empty of [null, undefined, "", "   "])
    assert.deepEqual(parseComposeUpArgs(empty), []);
});

test("ordinary compose flags are accepted", () => {
  for (const ok of [
    "",
    "   ",
    "--force-recreate",
    "--pull always",
    "--scale web=3 --scale worker=2",
    "--timeout=60 --wait --renew-anon-volumes",
    "--exit-code-from=web",
  ])
    assert.equal(validateComposeUpArgs(ok), null, ok);
});

test("the flags that choose the stack are refused", () => {
  // Each of these would aim the command at a different project, file or env,
  // which is how a deploy reports green while the real app never restarted.
  for (const denied of [
    "-p other",
    "--project-name=other",
    "-f /tmp/evil.yml",
    "--file /tmp/evil.yml",
    "--env-file /etc/shadow",
    "--project-directory /",
    "--force-recreate -p other",
  ]) {
    const problem = validateComposeUpArgs(denied);
    assert.ok(problem, `${denied} must be refused`);
    assert.match(problem!, /Deplo's to set/);
  }
});

test("a whole command, pasted in, is refused with a reason", () => {
  // The failure mode of the "custom command" design this replaces: someone pastes
  // the entire invocation. Name the first token so it is obvious why.
  const problem = validateComposeUpArgs("compose -p app -f app.yml up -d");
  assert.ok(problem);
  assert.match(problem!, /Extra flags only/);
  assert.match(problem!, /compose/);
});

test("shell syntax and quoting are refused - the command runs without a shell", () => {
  for (const bad of [
    "--pull always; rm -rf /",
    '--label "a b"',
    "--pull $(id)",
    "--x|y",
  ]) {
    const problem = validateComposeUpArgs(bad);
    assert.ok(problem, `${bad} must be refused`);
  }
});

test("the set is bounded", () => {
  assert.match(
    validateComposeUpArgs(new Array(25).fill("--wait").join(" "))!,
    /25 arguments/,
  );
  assert.match(
    validateComposeUpArgs(`--${"x".repeat(200)}`)!,
    /longer than 128/,
  );
});

test("the preview is the command, not a description of it", () => {
  assert.equal(
    composeUpCommandPreview({ slug: "api", usesEnvFile: false, extra: [] }),
    "docker compose -p deplo-api -f /data/stacks/api.yml up -d --remove-orphans",
  );
  // A compose stack interpolates ${VAR}, so its bring-up carries an env-file.
  assert.equal(
    composeUpCommandPreview({
      slug: "api",
      usesEnvFile: true,
      extra: ["--pull", "always"],
    }),
    "docker compose -p deplo-api -f /data/stacks/api.yml --env-file /data/stacks/api.env " +
      "up -d --remove-orphans --pull always",
  );
});
