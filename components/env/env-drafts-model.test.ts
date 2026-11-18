import { test } from "node:test";
import assert from "node:assert/strict";

import {
  draftTag,
  newDraft,
  pasteIntoDrafts,
  savableDrafts,
  type KnownVar,
} from "./env-drafts-model";

const PASTE = [
  "# Postgres connection string.",
  "DATABASE_URL=postgres://db",
  "",
  "# Ask Maria first.",
  "",
  "MAIL_FROM=shop@acme.com",
  "NEXT_PUBLIC_SITE_NAME=Acme",
  "MAIL_FROM=shop@acme.it",
].join("\n");

test("a pasted .env replaces the empty draft it landed in, one draft per name", () => {
  const typed = newDraft({ key: "KEEP_ME", value: "1" });
  const empty = newDraft();
  const out = pasteIntoDrafts([typed, empty], empty.id, PASTE)!;
  assert.deepEqual(
    out.map((d) => [d.key, d.value]),
    [
      ["KEEP_ME", "1"],
      ["DATABASE_URL", "postgres://db"],
      ["MAIL_FROM", "shop@acme.it"],
      ["NEXT_PUBLIC_SITE_NAME", "Acme"],
    ],
  );
  assert.ok(out.slice(1).every((d) => !d.open && !d.secret));
});

test("text with no variable in it is an ordinary paste", () => {
  assert.equal(pasteIntoDrafts([newDraft()], "x", "just a word"), null);
});

test("each draft says what saving it does to the list", () => {
  const known: KnownVar[] = [
    { key: "DATABASE_URL", type: "plain", pending: true },
    { key: "NEXT_PUBLIC_SITE_NAME", type: "plain" },
    { key: "STRIPE_KEY", type: "secret" },
  ];
  const tag = (key: string, patch = {}) =>
    draftTag(newDraft({ key, ...patch }), known);
  assert.equal(tag("DATABASE_URL"), "fills");
  assert.equal(tag("NEXT_PUBLIC_SITE_NAME"), "replaces");
  assert.equal(tag("STRIPE_KEY"), "secret-taken");
  assert.equal(tag("MAIL_FROM", { note: "Ask", noteLoose: true }), "loose");
  assert.equal(tag("REDIS_URL"), null);
});

test("only drafts with a valid name are saved", () => {
  assert.deepEqual(
    savableDrafts([
      newDraft({ key: "OK" }),
      newDraft({ key: "" }),
      newDraft({ key: "1BAD" }),
    ]).map((d) => d.key),
    ["OK"],
  );
});
