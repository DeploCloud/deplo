import test from "node:test";
import assert from "node:assert/strict";

import {
  isInterruptedLoadError,
  isStaleBuildError,
  recoverableError,
  reloadOnce,
  reloadWhenBack,
} from "./stale-build";

test("recognises a chunk that the current build no longer has", () => {
  const turbopack = new Error(
    "Failed to load chunk /_next/static/chunks/41cv1p9day2ol.js from module 964893",
  );
  turbopack.name = "ChunkLoadError";
  assert.equal(isStaleBuildError(turbopack), true);

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
  const digested = Object.assign(new Error(""), { digest: "1234567890" });
  assert.equal(isStaleBuildError(digested), false);
  assert.equal(isStaleBuildError(null), false);
  assert.equal(isStaleBuildError(undefined), false);
});

test("recognises a page whose stream the network cut halfway", () => {
  for (const message of [
    "Connection closed.",
    "Minified React error #412; visit https://react.dev/errors/412 for the full message",
    "Load failed",
    "network error",
    "Failed to fetch",
    "TypeError: Error in input stream",
    "NetworkError when attempting to fetch resource.",
    "The network connection was lost.",
    "The Internet connection appears to be offline.",
  ])
    assert.equal(
      recoverableError(new TypeError(message)),
      "interrupted",
      message,
    );

  const chunk = new Error("Failed to fetch dynamically imported module: /x.js");
  assert.equal(recoverableError(chunk), "stale");
  assert.equal(isInterruptedLoadError(chunk), false);
  assert.equal(recoverableError(new Error("No active team")), null);
  assert.equal(
    recoverableError(new Error("Failed to fetch apps for team")),
    null,
  );
  assert.equal(
    recoverableError(new Error("https://react.dev/errors/4123")),
    null,
  );
});

test("waits until the app is on screen and online before reloading", () => {
  let reloads = 0;
  const doc = new EventTarget() as EventTarget & { hidden: boolean };
  doc.hidden = true;
  const win = Object.assign(new EventTarget(), {
    location: { reload: () => void reloads++ },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  });
  const nav = { onLine: false };
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    navigator: g.navigator,
  };
  Object.assign(g, { window: win, document: doc });
  Object.defineProperty(g, "navigator", { value: nav, configurable: true });
  try {
    reloadWhenBack();
    assert.equal(reloads, 0);
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(reloads, 0, "still offline");
    nav.onLine = true;
    win.dispatchEvent(new Event("online"));
    assert.equal(reloads, 1);
    win.dispatchEvent(new Event("online"));
    assert.equal(reloads, 1, "listeners are gone");
  } finally {
    Object.assign(g, { window: saved.window, document: saved.document });
    Object.defineProperty(g, "navigator", {
      value: saved.navigator,
      configurable: true,
    });
  }
});
