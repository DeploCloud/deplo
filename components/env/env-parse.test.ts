import { test } from "node:test";
import assert from "node:assert/strict";

import { clashingKeys, parseEnv } from "./env-parse";

test("only the pasted keys that already exist clash", () => {
  assert.deepEqual(
    clashingKeys(["API_URL", "NEW_ONE", " DB_HOST "], ["DB_HOST", "API_URL"]),
    ["API_URL", "DB_HOST"],
  );
});

test("a key pasted twice is listed once", () => {
  assert.deepEqual(clashingKeys(["A", "A"], ["A"]), ["A"]);
});

test("nothing existing means nothing to confirm", () => {
  assert.deepEqual(clashingKeys(["A", "B"], []), []);
});

test("a pasted .env loses its comments", () => {
  assert.deepEqual(
    parseEnv(
      [
        "# database",
        "DB_HOST=db.acme.com # primary",
        'API_KEY="a # b" # quoted hash stays',
        "TOKEN='x'#tight",
        "EMPTY= # nothing",
        "COLOR=#ff0000",
        "URL=https://acme.com/#top",
        'ESCAPED="a\\"b"',
      ].join("\n"),
    ),
    [
      { key: "DB_HOST", value: "db.acme.com" },
      { key: "API_KEY", value: "a # b" },
      { key: "TOKEN", value: "x" },
      { key: "EMPTY", value: "" },
      { key: "COLOR", value: "#ff0000" },
      { key: "URL", value: "https://acme.com/#top" },
      { key: "ESCAPED", value: 'a\\"b' },
    ],
  );
});
