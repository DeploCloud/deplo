import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPasswordPolicy,
  generatePassword,
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
  assert.equal(
    passwordMeetsPolicy(`Aa1!${"x".repeat(200)}`),
    false,
    "over the cap",
  );
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

test("generatePassword: every suggestion passes the gate that follows it", () => {
  for (let i = 0; i < 2000; i++) {
    const p = generatePassword();
    assert.equal(
      passwordMeetsPolicy(p),
      true,
      `${p} -> ${passwordPolicyError(p)}`,
    );
  }
  assert.equal(generatePassword().length, 20);
  assert.equal(generatePassword(32).length, 32);
  // A short request still clears the length rule.
  assert.equal(passwordMeetsPolicy(generatePassword(4)), true);
});

test("generatePassword: unambiguous characters only, and unbiased", () => {
  const seen = new Map<string, number>();
  for (let i = 0; i < 20000; i++)
    for (const c of generatePassword()) seen.set(c, (seen.get(c) ?? 0) + 1);
  for (const c of "lIO01") assert.equal(seen.has(c), false, `ambiguous ${c}`);

  // Uniformity holds WITHIN a class; across classes the guaranteed one-of-each
  // skews on purpose. Modulo bias would show as a ratio near 4/3 inside a class.
  for (const cls of [
    "abcdefghijkmnopqrstuvwxyz",
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "23456789",
    "!*+-._~",
  ]) {
    const counts = [...cls].map((c) => seen.get(c) ?? 0);
    const ratio = Math.max(...counts) / Math.min(...counts);
    assert.ok(ratio < 1.1, `biased within "${cls}": ${ratio.toFixed(3)}`);
  }
});
