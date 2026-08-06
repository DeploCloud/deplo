import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPasswordPolicy,
  passwordMeetsPolicy,
  passwordPolicyError,
  passwordRuleStatus,
} from "./password-policy";

test("passwordMeetsPolicy: every rule must hold", () => {
  assert.equal(passwordMeetsPolicy("Str0ng!pass"), true);
  assert.equal(passwordMeetsPolicy("Sh0rt!a"), false, "7 chars");
  assert.equal(passwordMeetsPolicy("nocaps123!"), false, "no uppercase");
  assert.equal(passwordMeetsPolicy("NOLOWER123!"), false, "no lowercase");
  assert.equal(passwordMeetsPolicy("NoDigits!!"), false, "no number");
  assert.equal(passwordMeetsPolicy("NoSpecial123"), false, "no special char");
  assert.equal(passwordMeetsPolicy(`Aa1!${"x".repeat(200)}`), false, "over the cap");
  // "Special" is anything non-alphanumeric, not a hand-picked punctuation set.
  assert.equal(passwordMeetsPolicy("Str0ng~pass"), true);
  assert.equal(passwordMeetsPolicy("Str0ng pass"), true);
});

test("passwordPolicyError: names everything missing, null once it passes", () => {
  assert.equal(passwordPolicyError("Str0ng!pass"), null);
  assert.equal(
    passwordPolicyError("abc"),
    "Choose a password with at least: 8 characters, 1 number, 1 uppercase letter, 1 special character",
  );
  assert.match(passwordPolicyError(`Aa1!${"x".repeat(200)}`)!, /at most 200/);
});

test("passwordRuleStatus: one entry per rule, in display order", () => {
  const rules = passwordRuleStatus("aaaaaaaa");
  assert.deepEqual(
    rules.map((r) => r.met),
    [true, false, true, false, false],
  );
});

test("assertPasswordPolicy: throws the message the UI shows, verbatim", () => {
  assert.doesNotThrow(() => assertPasswordPolicy("Str0ng!pass"));
  assert.throws(() => assertPasswordPolicy("hunter2"), {
    message:
      "Choose a password with at least: 8 characters, 1 uppercase letter, 1 special character",
  });
});
