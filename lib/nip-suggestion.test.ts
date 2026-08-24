import { test } from "node:test";
import assert from "node:assert/strict";

import { regenerateNipDomain } from "./nip-suggestion";

/**
 * The one thing Generate must never do is move the hostname to a different
 * server. Only the two random words are free: the label and the trailing hex IP
 * are what nip.io resolves, and rerolling either would hand out a name that
 * points somewhere else (or nowhere).
 */

const HEX = "9487cf1e.nip.io"; // 148.135.207.30

test("only the words change, and they do change", () => {
  const first = `traefik-brave-otter-${HEX}`;
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const next = regenerateNipDomain(first);
    assert.ok(next.startsWith("traefik-"), `label lost: ${next}`);
    assert.ok(next.endsWith(`-${HEX}`), `the server's IP moved: ${next}`);
    assert.match(next, /^traefik-[a-z0-9]+-[a-z0-9]+-9487cf1e\.nip\.io$/i);
    seen.add(next);
  }
  // Fifty rolls of ~427k word pairs landing on one name would not be randomness.
  assert.ok(seen.size > 1, "Generate must actually generate");
});

test("a label with hyphens in it stays whole", () => {
  const next = regenerateNipDomain(`my-long-app-name-brave-otter-${HEX}`);
  assert.ok(next.startsWith("my-long-app-name-"), next);
  assert.ok(next.endsWith(`-${HEX}`), next);
});

test("anything that is not a suggestion comes back untouched", () => {
  for (const name of [
    "traefik.example.com",
    "",
    "not-a-nip-host.nip.io",
    "brave-otter",
  ]) {
    assert.equal(regenerateNipDomain(name), name);
  }
});
