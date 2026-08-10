import { test } from "node:test";
import assert from "node:assert/strict";

import {
  S3_ARGS_ALLOWED,
  S3_ARGS_MAX_TOKENS,
  parseS3Args,
  validateS3Args,
} from "./s3-args";

test("every allowed flag passes with either boolean", () => {
  for (const name of Object.keys(S3_ARGS_ALLOWED)) {
    assert.equal(validateS3Args(`${name}=true`), null, name);
    assert.equal(validateS3Args(`${name}=false`), null, name);
  }
  // And several at once, which is how a broken gateway usually needs them.
  assert.equal(
    validateS3Args("--s3-sign-accept-encoding=false --s3-force-path-style=true"),
    null,
  );
});

test("empty is fine — the field is optional", () => {
  assert.equal(validateS3Args(""), null);
  assert.equal(validateS3Args("   "), null);
  assert.deepEqual(parseS3Args(null), []);
  assert.deepEqual(parseS3Args("  --a=1   --b=2 "), ["--a=1", "--b=2"]);
});

test("a flag Deplo cannot apply is refused BY NAME, with the list", () => {
  // The point of the allowlist: a real rclone flag that the agent has no mapping
  // for must not be accepted and silently dropped.
  const msg = validateS3Args("--s3-upload-cutoff=200M");
  assert.match(msg ?? "", /doesn't know "--s3-upload-cutoff"/);
  assert.match(msg ?? "", /--s3-sign-accept-encoding/);
});

test("a flag without a value says what the value should look like", () => {
  assert.match(
    validateS3Args("--s3-force-path-style") ?? "",
    /needs a value, like --s3-force-path-style=true/,
  );
});

test("only true/false, and the message names the flag", () => {
  assert.match(
    validateS3Args("--s3-force-path-style=maybe") ?? "",
    /"--s3-force-path-style" takes true or false, not "maybe"/,
  );
});

test("shell syntax and quoting are refused, not escaped", () => {
  for (const bad of [
    "--s3-force-path-style=true; rm -rf /",
    '"--s3-force-path-style=true"',
    "--s3-force-path-style=$(whoami)",
    "--s3-force-path-style=`id`",
  ]) {
    assert.notEqual(validateS3Args(bad), null, bad);
  }
});

test("too many flags is refused before the allowlist is even consulted", () => {
  const many = Array.from(
    { length: S3_ARGS_MAX_TOKENS + 1 },
    () => "--s3-force-path-style=true",
  ).join(" ");
  assert.match(validateS3Args(many) ?? "", /is the most a destination can take/);
});
