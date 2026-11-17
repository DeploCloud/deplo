import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEnvFile } from "./env-file";

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
      { key: "KEY", value: "-----BEGIN-----\nBODY\n-----END-----" },
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
