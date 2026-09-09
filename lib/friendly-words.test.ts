import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FRIENDLY_ADJECTIVES,
  FRIENDLY_ANIMALS,
  friendlyWords,
} from "./friendly-words";

/**
 * The words end up in the URL a first deploy hands you. A general-purpose
 * dictionary produced `obnoxious-kite` and `fat-hookworm`, which is why this
 * list is curated and why nothing unflattering may creep back in.
 */

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

test("a pair is two known words joined by one dash", () => {
  for (let i = 0; i < 200; i++) {
    const [adjective, animal, ...rest] = friendlyWords().split("-");
    assert.equal(rest.length, 0);
    assert.ok(FRIENDLY_ADJECTIVES.includes(adjective!));
    assert.ok(FRIENDLY_ANIMALS.includes(animal!));
  }
});
