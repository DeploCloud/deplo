import { test } from "node:test";
import assert from "node:assert/strict";

import { noteInput, parseEnvFile } from "./env-file";

test("comments and inline comments never reach a value", () => {
  assert.deepEqual(
    parseEnvFile(
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
      { key: "DB_HOST", value: "db.acme.com", note: "primary" },
      { key: "API_KEY", value: "a # b", note: "quoted hash stays" },
      { key: "TOKEN", value: "x", note: "tight" },
      { key: "EMPTY", value: "", note: "nothing" },
      { key: "COLOR", value: "#ff0000" },
      { key: "URL", value: "https://acme.com/#top" },
      { key: "ESCAPED", value: 'a\\"b' },
    ],
  );
});

test("shell exports, CRLF and a key that is not a name are read as written", () => {
  assert.deepEqual(parseEnvFile("export A=1\r\nB = two \r\n1BAD=x\r\nnoise"), [
    { key: "A", value: "1" },
    { key: "B", value: "two" },
    { key: "1BAD", value: "x" },
  ]);
});

test("a quoted value may span lines, with a comment after it", () => {
  assert.deepEqual(
    parseEnvFile('KEY="-----BEGIN-----\nBODY\n-----END-----" # pem\nNEXT=1'),
    [
      {
        key: "KEY",
        value: "-----BEGIN-----\nBODY\n-----END-----",
        note: "pem",
      },
      { key: "NEXT", value: "1" },
    ],
  );
});

test("a quote that never closes stays part of the value", () => {
  assert.deepEqual(parseEnvFile('A="open\nB=2'), [
    { key: "A", value: '"open' },
    { key: "B", value: "2" },
  ]);
});

test("a repeated key keeps its first place and its last value", () => {
  assert.deepEqual(parseEnvFile("A=1\nB=2\nA=3"), [
    { key: "A", value: "3" },
    { key: "B", value: "2" },
  ]);
  assert.deepEqual(parseEnvFile(null), []);
});

test("the comment block right above a key becomes its note", () => {
  assert.deepEqual(
    parseEnvFile(
      [
        "# --- Database ---",
        "",
        "# ==========",
        "# Pool size for",
        "#   the API",
        "DB_POOL=10",
        "API_URL=https://acme.com  # public base URL",
        "# not for this one",
        "noise",
        "DEBUG=false",
        "# both",
        "PORT=3000 # inline wins",
        "EMPTY_INLINE=1 #",
      ].join("\n"),
    ),
    [
      { key: "DB_POOL", value: "10", note: "Pool size for the API" },
      { key: "API_URL", value: "https://acme.com", note: "public base URL" },
      { key: "DEBUG", value: "false" },
      { key: "PORT", value: "3000", note: "inline wins" },
      { key: "EMPTY_INLINE", value: "1" },
    ],
  );
});

test("a pasted note over the limit is cut and says so", () => {
  const [e] = parseEnvFile(`# ${"a".repeat(300)}\nKEY=1`);
  assert.equal(e.note?.length, 280);
  assert.equal(e.noteCut, true);
});

test("a typed note over the limit is refused, whitespace folds to one line", () => {
  assert.equal(noteInput("  two\n lines "), "two lines");
  assert.equal(noteInput("   "), null);
  assert.throws(() => noteInput("a".repeat(281)), /at most 280/);
});
