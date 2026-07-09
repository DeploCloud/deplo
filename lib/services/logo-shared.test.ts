import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidLogoValue,
  isTemplateLogo,
  MAX_LOGO_STRING_LEN,
} from "./logo-shared";

test("isValidLogoValue: accepts a png image data-URI", () => {
  assert.equal(isValidLogoValue("data:image/png;base64,iVBORw0KGgo="), true);
});

test("isValidLogoValue: accepts jpeg / webp / gif / svg / ico data-URIs", () => {
  for (const mime of [
    "jpeg",
    "webp",
    "gif",
    "svg+xml",
    "x-icon",
    "vnd.microsoft.icon",
  ]) {
    assert.equal(
      isValidLogoValue(`data:image/${mime};base64,QUJD`),
      true,
      mime,
    );
  }
});

test("isValidLogoValue: accepts a clean /templates path (template default)", () => {
  assert.equal(isValidLogoValue("/templates/n8n.svg"), true);
  assert.equal(isValidLogoValue("/templates/actual-budget.png"), true);
});

test("isValidLogoValue: rejects remote URLs", () => {
  assert.equal(isValidLogoValue("https://evil.example.com/logo.png"), false);
  assert.equal(isValidLogoValue("http://10.0.0.1/probe.png"), false);
  assert.equal(isValidLogoValue("//cdn.example.com/x.png"), false);
});

test("isValidLogoValue: rejects non-image and script data-URIs", () => {
  assert.equal(isValidLogoValue("data:text/html;base64,PHNjcmlwdD4="), false);
  assert.equal(
    isValidLogoValue("data:application/javascript;base64,YWxlcnQoMSk="),
    false,
  );
  assert.equal(isValidLogoValue("javascript:alert(1)"), false);
});

test("isValidLogoValue: rejects /templates path traversal and subdirs", () => {
  assert.equal(isValidLogoValue("/templates/../../etc/passwd"), false);
  assert.equal(isValidLogoValue("/templates/sub/dir.png"), false);
  assert.equal(isValidLogoValue("/public/secret.png"), false);
});

test("isValidLogoValue: rejects a data-URI longer than the cap", () => {
  const huge = "data:image/png;base64," + "A".repeat(MAX_LOGO_STRING_LEN);
  assert.equal(isValidLogoValue(huge), false);
});

test("isValidLogoValue: rejects an empty or malformed data-URI", () => {
  assert.equal(isValidLogoValue("data:image/png;base64,"), false);
  assert.equal(isValidLogoValue("data:image/png,notbase64"), false);
});

test("isTemplateLogo: true only for a clean /templates path (the value that wins over detection)", () => {
  assert.equal(isTemplateLogo("/templates/n8n.svg"), true);
  assert.equal(isTemplateLogo("/templates/actual-budget.png"), true);
  // A user-uploaded / auto-detected inline image is NOT a template default.
  assert.equal(isTemplateLogo("data:image/png;base64,iVBORw0KGgo="), false);
  assert.equal(isTemplateLogo(null), false);
  assert.equal(isTemplateLogo(undefined), false);
  assert.equal(isTemplateLogo(""), false);
  // Traversal / subdirs are not template logos (and aren't valid logos either).
  assert.equal(isTemplateLogo("/templates/../../etc/passwd"), false);
  assert.equal(isTemplateLogo("/templates/sub/dir.png"), false);
});
