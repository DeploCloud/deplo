import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEnvBlob } from "../map/env";
import { toEnvBlob } from "./env-blob";

const VALUES: Record<string, string> = {
  PLAIN: "value",
  EMPTY: "",
  SPACED: "  padded  ",
  QUOTED: '"already quoted"',
  SINGLE: "'single'",
  HASH: "a # not a comment",
  EQUALS: "a=b=c",
  TRAILING_QUOTE: 'ends with "',
  LONE_QUOTE: '"',
  PEM: "-----BEGIN KEY-----\nMIIBOgIBAAJBAK\n-----END KEY-----",
  JSON: '{\n  "a": "b"\n}',
  BLANK_LINES: "one\n\n\nfour",
  QUOTE_LINES: 'a "x"\nb "y"\nlast',
  DOLLAR: "${{ team.NOT_A_REF }} $HOME",
};

test("every value a person can type comes back exactly", () => {
  const entries = Object.entries(VALUES).map(([key, value]) => ({
    key,
    value,
  }));
  const { blob, unrepresentable } = toEnvBlob(entries);
  assert.deepEqual(unrepresentable, []);
  assert.deepEqual(parseEnvBlob(blob), entries);
});

test("a value the blob cannot carry exactly is named, not altered", () => {
  const { blob, unrepresentable } = toEnvBlob([
    { key: "KEEP", value: "ok" },
    { key: "TRAILING_SPACE_LINE", value: "first   \nsecond" },
    { key: "BOTH_QUOTES", value: "a\"\nb'\nc" },
    { key: "bad-key", value: "x" },
  ]);
  assert.deepEqual(unrepresentable.sort(), [
    "BOTH_QUOTES",
    "TRAILING_SPACE_LINE",
    "bad-key",
  ]);
  assert.deepEqual(parseEnvBlob(blob), [{ key: "KEEP", value: "ok" }]);
});
