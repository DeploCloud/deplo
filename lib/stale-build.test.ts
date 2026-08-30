import test from "node:test";
import assert from "node:assert/strict";

import { isStaleBuildError, reloadOnce } from "./stale-build";

/**
 * The error boundaries turn a stale-build error into "reload", and anything else
 * into "Something went wrong".
 */
test("recognises a chunk that the current build no longer has", () => {
  const turbopack = new Error(
    "Failed to load chunk /_next/static/chunks/41cv1p9day2ol.js from module 964893",
  );
  turbopack.name = "ChunkLoadError";
  assert.equal(isStaleBuildError(turbopack), true);

  // Same failure, other bundlers/browsers.
  assert.equal(
    isStaleBuildError(
      new Error("Loading chunk 493 failed. (missing: /_next/…)"),
    ),
    true,
  );
  assert.equal(
    isStaleBuildError(new Error("Loading CSS chunk 12 failed.")),
    true,
  );
  assert.equal(
    isStaleBuildError(
      new Error("Failed to fetch dynamically imported module: /_next/x.js"),
    ),
    true,
  );
  assert.equal(
    isStaleBuildError(new Error("error loading dynamically imported module")),
    true,
  );
  assert.equal(
    isStaleBuildError(new Error("Importing a module script failed.")),
    true,
  );

  // The name alone is enough - some bundlers throw it with an empty message.
  const bare = new Error("");
  bare.name = "ChunkLoadError";
  assert.equal(isStaleBuildError(bare), true);
});

test("reloads once, then leaves it to the user", () => {
  let reloads = 0;
  const store = new Map<string, string>();
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    location: { reload: () => void reloads++ },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  };
  try {
    assert.equal(reloadOnce(), true);
    assert.equal(reloads, 1);
    // A build whose chunks are missing too would otherwise reload forever.
    assert.equal(reloadOnce(), false);
    assert.equal(reloads, 1);
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
});

test("a real crash is never mistaken for a stale tab", () => {
  assert.equal(isStaleBuildError(new Error("Something went wrong")), false);
  assert.equal(isStaleBuildError(new TypeError("x is not a function")), false);
  assert.equal(
    isStaleBuildError(
      new Error("You don't have permission to create databases"),
    ),
    false,
  );
  // A server error reaches the boundary as a digest-only Error.
  const digested = Object.assign(new Error(""), { digest: "1234567890" });
  assert.equal(isStaleBuildError(digested), false);
  assert.equal(isStaleBuildError(null), false);
  assert.equal(isStaleBuildError(undefined), false);
});
