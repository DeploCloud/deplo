import { test } from "node:test";
import assert from "node:assert/strict";

import { regenerateAutoDomain } from "./auto-domain-suggestion";

const HEX = "9487cf1e.deplo.site";

test("only the word changes, and it does change", () => {
  const first = `traefik-otter-${HEX}`;
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const next = regenerateAutoDomain(first);
    assert.ok(next.startsWith("traefik-"), `label lost: ${next}`);
    assert.ok(next.endsWith(`-${HEX}`), `the server's IP moved: ${next}`);
    assert.match(next, /^traefik-[a-z0-9]+-9487cf1e\.deplo\.site$/i);
    seen.add(next);
  }
  assert.ok(seen.size > 1, "Generate must actually generate");
});

test("a label with hyphens in it stays whole", () => {
  const next = regenerateAutoDomain(`my-long-app-name-otter-${HEX}`);
  assert.ok(next.startsWith("my-long-app-name-"), next);
  assert.ok(next.endsWith(`-${HEX}`), next);
});

test("a name minted on a legacy wildcard keeps its own zone", () => {
  const next = regenerateAutoDomain("traefik-otter-9487cf1e.nip.io");
  assert.ok(next.endsWith("-9487cf1e.nip.io"), next);
  assert.match(next, /^traefik-[a-z0-9]+-9487cf1e\.nip\.io$/i);
});

test("anything that is not a suggestion comes back untouched", () => {
  for (const name of [
    "traefik.example.com",
    "",
    "not-a-generated-host.deplo.site",
    "otter",
  ]) {
    assert.equal(regenerateAutoDomain(name), name);
  }
});
