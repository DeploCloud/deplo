import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMPOSE_UP_ARGS_MAX_TOKENS,
  composeDeployArgs,
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
  // A compose stack interpolates ${VAR}, so its bring-up carries an env-file,
  // and a deploy of it pulls.
  assert.equal(
    composeUpCommandPreview({
      slug: "api",
      usesEnvFile: true,
      extra: ["--wait"],
    }),
    "docker compose -p deplo-api -f /data/stacks/api.yml --env-file /data/stacks/api.env " +
      "up -d --remove-orphans --pull always --wait",
  );
  // The operator's own --pull is the one that runs.
  assert.equal(
    composeUpCommandPreview({
      slug: "api",
      usesEnvFile: true,
      extra: ["--pull", "missing"],
    }),
    "docker compose -p deplo-api -f /data/stacks/api.yml --env-file /data/stacks/api.env " +
      "up -d --remove-orphans --pull missing",
  );
});

test("a compose stack's deploy pulls unless the operator chose a pull policy", () => {
  assert.deepEqual(composeDeployArgs([]), ["--pull", "always"]);
  assert.deepEqual(composeDeployArgs(["--wait"]), [
    "--pull",
    "always",
    "--wait",
  ]);
  // `--pull missing` is how an image that exists only on the host keeps working.
  assert.deepEqual(composeDeployArgs(["--pull", "missing"]), [
    "--pull",
    "missing",
  ]);
  assert.deepEqual(composeDeployArgs(["--wait", "--pull=never"]), [
    "--wait",
    "--pull=never",
  ]);
  // The agent drops the whole set past its cap, so a set at the cap stays as is.
  const atCap = Array.from(
    { length: COMPOSE_UP_ARGS_MAX_TOKENS - 1 },
    () => "--wait",
  );
  assert.deepEqual(composeDeployArgs(atCap), atCap);
  const withRoom = atCap.slice(0, COMPOSE_UP_ARGS_MAX_TOKENS - 2);
  assert.deepEqual(composeDeployArgs(withRoom), [
    "--pull",
    "always",
    ...withRoom,
  ]);
});
