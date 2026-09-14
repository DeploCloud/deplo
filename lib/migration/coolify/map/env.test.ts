import { test } from "node:test";
import assert from "node:assert/strict";

import { coolifyApplication } from "./applications";
import { coolifyEnvBlob, withoutPanelInternals } from "./env";
import { parseEnvBlob } from "../../map/env";

test("coolifyEnvBlob takes the resolved value and leaves previews behind", () => {
  const r = coolifyEnvBlob([
    { key: "APP_KEY", value: "$SERVICE_PASSWORD_APP", real_value: "aB3k9" },
    { key: "PLAIN", value: "yes" },
    { key: "ONLY_PREVIEW", value: "x", is_preview: true },
    { key: "BUILT", value: "b", is_buildtime: true, is_runtime: false },
    { key: "SHARED", value: "{{team.SMTP_HOST}}" },
    { key: "  ", value: "dropped" },
  ]);
  assert.equal(
    r.blob,
    "APP_KEY=aB3k9\nPLAIN=yes\nBUILT=b\nSHARED={{team.SMTP_HOST}}",
  );
  assert.deepEqual(r.previewKeys, ["ONLY_PREVIEW"]);
  // ...and their values ride along, for Deplo's own preview variables.
  assert.equal(r.previewBlob, "ONLY_PREVIEW=x");
  assert.deepEqual(r.buildOnlyKeys, ["BUILT"]);
  assert.deepEqual(r.sharedRefs, [
    { key: "SHARED", level: "team", sharedKey: "SMTP_HOST", whole: true },
  ]);
  assert.equal(r.masked, false);
});

// A token that can actually run an import gets `real_value`, the panel HAVING ALREADY RESOLVED the reference away, so refs read off it are empty on every real migration.
test("a reference is read off the stored value, not the resolved one", () => {
  const r = coolifyEnvBlob([
    { key: "SMTP_HOST", value: "{{team.SMTP_HOST}}", real_value: "mail.acme" },
    {
      key: "URL",
      value: "https://{{server.HOST}}/api",
      real_value: "https://h/api",
    },
    { key: "PREVIEW_REF", value: "{{team.X}}", is_preview: true },
  ]);
  assert.equal(r.blob, "SMTP_HOST=mail.acme\nURL=https://h/api");
  assert.deepEqual(r.sharedRefs, [
    { key: "SMTP_HOST", level: "team", sharedKey: "SMTP_HOST", whole: true },
    { key: "URL", level: "server", sharedKey: "HOST", whole: false },
  ]);
});

// The single worst failure this adapter can have: a token without read:sensitive gets rows with NO value key at all, and importing them lands empty variables.
test("coolifyEnvBlob says when the values never arrived", () => {
  const r = coolifyEnvBlob([{ key: "APP_KEY" }, { key: "PLAIN" }]);
  assert.equal(r.masked, true);
  assert.equal(coolifyEnvBlob([]).masked, false);
});

// One normal variable in the list is enough for `masked` to stay false, so the whole safety net used to miss a value the panel simply refuses to repeat.
test("coolifyEnvBlob names the variables the panel would not answer for", () => {
  const r = coolifyEnvBlob([
    { key: "PLAIN", value: "yes" },
    { key: "DB_PASSWORD", is_shown_once: true },
    { key: "EMPTY_ON_PURPOSE", value: "" },
  ]);
  assert.equal(r.masked, false);
  assert.deepEqual(r.unreadableKeys, ["DB_PASSWORD"]);
  assert.equal(r.blob, "PLAIN=yes\nDB_PASSWORD=\nEMPTY_ON_PURPOSE=");
});

// The panel's own verdict is the only thing that types a variable secret: shown-once WITH a value lands write-only, one without stays plain, and the name means nothing.
test("coolifyEnvBlob carries the panel's shown-once flag, and only that", () => {
  const r = coolifyEnvBlob([
    { key: "API_TOKEN", value: "t0k3n", is_shown_once: true },
    { key: "DB_PASSWORD", is_shown_once: true },
    { key: "STRIPE_SECRET", value: "sk_live", is_shown_once: false },
  ]);
  assert.deepEqual(r.secretKeys, ["API_TOKEN"]);
  assert.deepEqual(r.unreadableKeys, ["DB_PASSWORD"]);
  const app = coolifyApplication(
    { uuid: "a1", name: "web", build_pack: "nixpacks" } as never,
    { env: r.blob, secretEnvKeys: r.secretKeys },
  );
  assert.deepEqual(app.secretEnvKeys, ["API_TOKEN"]);
});

test("a dollar the panel would have interpolated is named; a literal one is not", () => {
  const r = coolifyEnvBlob([
    { key: "LITERAL", value: "pa$$w0rd$1", is_literal: true },
    { key: "OPEN", value: "pa$$w0rd$1", is_literal: false },
    {
      key: "REF",
      value: "{{project.SHARED}}",
      real_value: "x$y",
      is_literal: false,
    },
    { key: "PLAIN", value: "hello", is_literal: false },
  ]);
  assert.deepEqual(r.interpolatedKeys, ["OPEN"]);
  assert.match(r.blob, /LITERAL=pa\$\$w0rd\$1/);
});

test("a multi-line value survives the blob it travels in", () => {
  const key = "-----BEGIN PLAIN-----\nLINE1\nLINE2\n-----END PLAIN-----";
  const r = coolifyEnvBlob([
    { key: "PLAIN_MULTI", value: key },
    { key: "AFTER", value: "still here" },
  ]);
  assert.deepEqual(parseEnvBlob(r.blob), [
    { key: "PLAIN_MULTI", value: key },
    { key: "AFTER", value: "still here" },
  ]);
});

test("a multi-line value the panel already quoted is not quoted twice", () => {
  const r = coolifyEnvBlob([
    { key: "QUOTED", value: "'-----BEGIN-----\nBODY\n-----END-----'" },
  ]);
  assert.deepEqual(parseEnvBlob(r.blob), [
    { key: "QUOTED", value: "-----BEGIN-----\nBODY\n-----END-----" },
  ]);
});

test("Coolify's own bookkeeping never becomes a shared variable", () => {
  const blob = [
    "COOLIFY_SERVER_UUID=abc",
    "COOLIFY_SERVER_NAME=localhost",
    "SMTP_HOST=mail.acme.test",
  ].join("\n");
  assert.equal(withoutPanelInternals(blob), "SMTP_HOST=mail.acme.test");
  // Nothing of ours is dropped with them.
  assert.equal(withoutPanelInternals("A=1\nB=2"), "A=1\nB=2");
});
