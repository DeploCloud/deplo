import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FRIENDLY_ADJECTIVES,
  FRIENDLY_ANIMALS,
  friendlyWord,
} from "./friendly-words";

test("every word is a plain lowercase label", () => {
  for (const w of [...FRIENDLY_ADJECTIVES, ...FRIENDLY_ANIMALS])
    assert.match(w, /^[a-z]{3,12}$/, w);
});

test("no duplicates, and enough of both to keep names varied", () => {
  assert.equal(new Set(FRIENDLY_ADJECTIVES).size, FRIENDLY_ADJECTIVES.length);
  assert.equal(new Set(FRIENDLY_ANIMALS).size, FRIENDLY_ANIMALS.length);
  assert.ok(FRIENDLY_ADJECTIVES.length >= 40);
  assert.ok(FRIENDLY_ANIMALS.length >= 40);
});

test("a word is one known label, from either list", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const w = friendlyWord();
    assert.ok(
      FRIENDLY_ADJECTIVES.includes(w) || FRIENDLY_ANIMALS.includes(w),
      w,
    );
    seen.add(w);
  }
  assert.ok(seen.size > 40, `only ${seen.size} distinct words in 400 draws`);
  assert.ok(FRIENDLY_ADJECTIVES.some((a) => seen.has(a)));
  assert.ok(FRIENDLY_ANIMALS.some((a) => seen.has(a)));
});
