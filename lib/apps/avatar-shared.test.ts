import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidAvatarValue, MAX_AVATAR_STRING_LEN } from "./avatar-shared";

test("isValidAvatarValue: accepts png / jpeg / webp data-URIs", () => {
  for (const mime of ["png", "jpeg", "webp"]) {
    assert.equal(
      isValidAvatarValue(`data:image/${mime};base64,QUJD`),
      true,
      mime,
    );
  }
});

test("isValidAvatarValue: rejects an SVG data-URI", () => {
  assert.equal(
    isValidAvatarValue("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="),
    false,
  );
});

test("isValidAvatarValue: rejects a /templates path", () => {
  assert.equal(isValidAvatarValue("/templates/n8n.svg"), false);
  assert.equal(isValidAvatarValue("/templates/actual-budget.png"), false);
});

test("isValidAvatarValue: rejects gif and ico, which only a logo accepts", () => {
  assert.equal(isValidAvatarValue("data:image/gif;base64,QUJD"), false);
  assert.equal(isValidAvatarValue("data:image/x-icon;base64,QUJD"), false);
});

test("isValidAvatarValue: rejects remote URLs", () => {
  assert.equal(isValidAvatarValue("https://evil.example.com/face.png"), false);
  assert.equal(isValidAvatarValue("http://10.0.0.1/probe.png"), false);
  assert.equal(isValidAvatarValue("//cdn.example.com/x.png"), false);
});

test("isValidAvatarValue: rejects non-image and script data-URIs", () => {
  assert.equal(isValidAvatarValue("data:text/html;base64,PHNjcmlwdD4="), false);
  assert.equal(isValidAvatarValue("javascript:alert(1)"), false);
});

test("isValidAvatarValue: rejects a data-URI over the cap, accepts one under", () => {
  const prefix = "data:image/webp;base64,";
  assert.equal(
    isValidAvatarValue(prefix + "A".repeat(MAX_AVATAR_STRING_LEN)),
    false,
  );
  assert.equal(
    isValidAvatarValue(
      prefix + "A".repeat(MAX_AVATAR_STRING_LEN - prefix.length - 1),
    ),
    true,
  );
});

test("isValidAvatarValue: rejects an empty or malformed data-URI", () => {
  assert.equal(isValidAvatarValue("data:image/png;base64,"), false);
  assert.equal(isValidAvatarValue("data:image/png,notbase64"), false);
});
