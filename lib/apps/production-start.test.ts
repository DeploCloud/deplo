import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { productionStartCommand } from "./framework-detect";

const manifest = (start: string, deps: Record<string, string> = {}) => ({
  scripts: { start },
  dependencies: deps,
});

describe("productionStartCommand", () => {
  test("a static Astro site whose start is `astro dev` is served on every address", () => {
    assert.equal(
      productionStartCommand(
        ["package.json", "pnpm-lock.yaml"],
        manifest("astro dev", { astro: "5" }),
        "astro",
      ),
      "pnpm exec astro preview --host 0.0.0.0 --port 4321",
    );
  });

  test("an Astro server build runs its own entry point", () => {
    assert.equal(
      productionStartCommand(
        ["package.json"],
        manifest("astro dev", { astro: "5", "@astrojs/node": "9" }),
        "astro",
      ),
      "HOST=0.0.0.0 PORT=4321 node ./dist/server/entry.mjs",
    );
  });

  test("next dev, nuxt dev and a bare vite are replaced", () => {
    assert.equal(
      productionStartCommand(["package.json"], manifest("next dev"), "nextjs"),
      "npx next start -H 0.0.0.0 -p 3000",
    );
    assert.equal(
      productionStartCommand(["package.json"], manifest("nuxt dev"), "nuxt"),
      "HOST=0.0.0.0 PORT=3000 node .output/server/index.mjs",
    );
    assert.equal(
      productionStartCommand(
        ["package.json", "yarn.lock"],
        manifest("vite", { vite: "6" }),
        "vite",
      ),
      "yarn vite preview --host 0.0.0.0 --port 4173",
    );
  });

  test("a real production start is left alone", () => {
    for (const start of [
      "next start",
      "node server.js",
      "astro preview",
      "vite build && serve dist",
    ])
      assert.equal(
        productionStartCommand(
          ["package.json"],
          manifest(start, { vite: "6" }),
          "astro",
        ),
        null,
        start,
      );
    assert.equal(productionStartCommand(["package.json"], {}, "astro"), null);
  });
});
