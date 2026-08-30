// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  backspace,
  caretFor,
  isComplete,
  moveCaret,
  pasteDigits,
  typeDigit,
  typeOrFill,
} from "./otp-field";

/**
 * The split code field's edit model.
 */

const L = 6;

test("typing fills left to right and advances", () => {
  let v = "";
  let caret = 0;
  for (const d of "123456") ({ value: v, caret } = typeDigit(v, caret, d, L));
  assert.equal(v, "123456");
  assert.ok(isComplete(v, L));
  // The caret parks on the last box rather than running off the end.
  assert.equal(caret, L - 1);
});

test("typing over a filled box replaces that digit, it does not insert", () => {
  const { value, caret } = typeDigit("123456", 2, "9", L);
  assert.equal(value, "129456", "one keystroke fixes a mistyped digit");
  assert.equal(caret, 3);
});

test("non-digits are dropped, not accepted and not thrown", () => {
  assert.equal(typeDigit("12", 2, "a", L).value, "12");
  assert.equal(typeDigit("12", 2, "", L).value, "12");
  // An IME or a repeat can deliver more than one character; the last wins.
  assert.equal(typeDigit("12", 2, "x7", L).value, "127");
});

test("a box past the first empty one is not reachable", () => {
  // Clicking box 5 of an empty field types into box 1 instead of leaving a gap.
  const { value, caret } = typeDigit("", 4, "7", L);
  assert.equal(value, "7", "no leading gap is created");
  assert.equal(caret, 1);
});

test("backspace at the end removes the last digit and follows it back", () => {
  const { value, caret } = backspace("1234", 4, L);
  assert.equal(value, "123");
  assert.equal(caret, 3);
});

test("backspace in the middle closes the gap", () => {
  const { value, caret } = backspace("123456", 1, L);
  assert.equal(value, "13456", "the field stays dense");
  assert.equal(caret, 1);
});

test("backspace on an empty field is a no-op, not an underflow", () => {
  const { value, caret } = backspace("", 0, L);
  assert.equal(value, "");
  assert.equal(caret, 0);
});

test("holding backspace clears the field one digit at a time", () => {
  let v = "482913";
  let caret = caretFor(v, L);
  for (let i = 0; i < 10; i++) ({ value: v, caret } = backspace(v, caret, L));
  assert.equal(v, "", "extra presses past empty change nothing");
  assert.equal(caret, 0);
});

test("pasting a whole code fills every box", () => {
  const { value, caret } = pasteDigits("", 0, "123456", L);
  assert.equal(value, "123456");
  assert.equal(caret, L - 1);
});

test("pasting tolerates the separators and whitespace people actually paste", () => {
  for (const raw of ["123 456", "123-456", " 123456\n", "code: 123456"])
    assert.equal(
      pasteDigits("", 0, raw, L).value,
      "123456",
      `paste of ${JSON.stringify(raw)}`,
    );
});

test("an overlong paste is truncated, not refused", () => {
  assert.equal(pasteDigits("", 0, "1234567890", L).value, "123456");
});

test("a paste with no digits leaves the field alone", () => {
  const { value } = pasteDigits("12", 2, "hello", L);
  assert.equal(value, "12");
});

test("pasting mid-field overwrites from the caret", () => {
  const { value } = pasteDigits("12", 2, "3456", L);
  assert.equal(value, "123456");
});

test("the caret never moves past the first empty box", () => {
  assert.equal(
    moveCaret("123", 2, 1, L),
    3,
    "one past the last digit is legal",
  );
  assert.equal(moveCaret("123", 3, 1, L), 3, "but no further");
  assert.equal(moveCaret("123", 0, -1, L), 0, "and never before the first");
  assert.equal(moveCaret("123456", 5, 1, L), 5, "nor past the last box");
});

test("caretFor is where focus lands after any external change", () => {
  assert.equal(caretFor("", L), 0);
  assert.equal(caretFor("123", L), 3);
  assert.equal(
    caretFor("123456", L),
    5,
    "a full field keeps focus on the last box",
  );
});

test("the model works at other lengths", () => {
  // Not a hypothetical: a recovery-style field would be a different length, and
  // nothing here may assume six.
  assert.equal(pasteDigits("", 0, "12345678", 8).value, "12345678");
  assert.ok(isComplete("1234", 4));
  assert.equal(caretFor("1234", 4), 3);
});

test("an autofilled code fills the field instead of leaving one digit", () => {
  // A password manager or platform one-time-code autofill puts the whole code
  // into the first box as ONE input event, with no paste event to catch it.
  // Keeping the last digit (which is right for a keystroke) would leave "6".
  assert.equal(typeOrFill("", 0, "123456", true, L).value, "123456");
});

test("replacing a digit is still a keystroke, not a fill", () => {
  // An occupied box reports "old+new" on a normal keypress; that must not be
  // mistaken for an autofill and written out as two digits.
  assert.equal(typeOrFill("1", 0, "19", false, L).value, "9");
  assert.equal(typeOrFill("123", 1, "27", false, L).value, "173");
});

test("a single digit into an empty box behaves the same either way", () => {
  assert.deepEqual(
    typeOrFill("12", 2, "3", true, L),
    typeDigit("12", 2, "3", L),
  );
});
