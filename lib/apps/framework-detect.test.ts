// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import {
  declaredDependencies,
  detectCommands,
  detectFramework,
  packageManagerFrom,
  parsePackageManifest,
  rootFileNames,
} from "./framework-detect";
import {
  FRAMEWORKS,
  effectiveFramework,
  frameworkById,
  isFrameworkId,
  supportsFrameworkDetection,
} from "./framework-catalog";

/** A package.json with the given direct dependencies. */
function pkg(deps: Record<string, string>, dev: Record<string, string> = {}) {
  return { dependencies: deps, devDependencies: dev };
}

test("names the framework from a single decisive dependency", () => {
  const cases: [Record<string, string>, string][] = [
    [{ next: "15.0.0", react: "19.0.0" }, "nextjs"],
    [{ nuxt: "3.14.0", vue: "3.5.0" }, "nuxt"],
    [{ "@sveltejs/kit": "2.0.0", svelte: "5.0.0" }, "sveltekit"],
    [{ astro: "5.0.0" }, "astro"],
    [{ "@remix-run/node": "2.15.0" }, "remix"],
    [{ "@react-router/dev": "7.1.0" }, "react-router"],
    [{ "@docusaurus/core": "3.6.0", react: "18.0.0" }, "docusaurus"],
    [{ gatsby: "5.14.0", react: "18.0.0" }, "gatsby"],
    [{ "@angular/core": "19.0.0" }, "angular"],
    [{ "@nestjs/core": "10.0.0", express: "4.21.0" }, "nestjs"],
    [{ "@adonisjs/core": "6.0.0" }, "adonisjs"],
    [{ "@strapi/strapi": "5.0.0" }, "strapi"],
    [{ "@builder.io/qwik-city": "1.12.0" }, "qwik"],
    [{ "@solidjs/start": "1.0.0", "solid-js": "1.9.0" }, "solid"],
    [{ "@11ty/eleventy": "3.0.0" }, "eleventy"],
    [{ "@vue/cli-service": "5.0.0", vue: "3.5.0" }, "vue"],
    [{ preact: "10.25.0" }, "preact"],
    [{ svelte: "5.0.0" }, "svelte"],
    [{ "react-scripts": "5.0.1", react: "18.0.0" }, "cra"],
    [{ express: "4.21.0" }, "express"],
    [{ fastify: "5.0.0" }, "fastify"],
    [{ hono: "4.6.0" }, "hono"],
    [{ koa: "2.15.0" }, "koa"],
  ];
  for (const [deps, expected] of cases) {
    assert.equal(
      detectFramework(["package.json"], pkg(deps)),
      expected,
      `deps ${JSON.stringify(deps)}`,
    );
  }
});

test("a meta-framework wins over the library it is built on", () => {
  // Every one of these repos also declares the base library; reporting React,
  // Vue or Vite for them would name the ingredient instead of the dish.
  assert.equal(
    detectFramework(
      ["package.json"],
      pkg({ next: "15.0.0", react: "19.0.0", express: "4.21.0" }),
    ),
    "nextjs",
  );
  assert.equal(
    detectFramework(
      ["package.json"],
      pkg({ nuxt: "3.14.0", vue: "3.5.0", vite: "6.0.0" }),
    ),
    "nuxt",
  );
  assert.equal(
    detectFramework(
      ["package.json"],
      pkg({ astro: "5.0.0" }, { vite: "6.0.0", "@astrojs/node": "9.0.0" }),
    ),
    "astro",
  );
  assert.equal(
    detectFramework(
      ["package.json"],
      pkg({ "@sveltejs/kit": "2.0.0" }, { svelte: "5.0.0", vite: "6.0.0" }),
    ),
    "sveltekit",
  );
});

test("a bare Vite SPA is Vite, not the library it renders with", () => {
  // Vue 3 and Solid both scaffold as plain Vite projects today, and a Vite
  // project is served by `vite preview` on 4173, which is the reason the
  // catalog refuses to name them: the port would be a guess.
  assert.equal(
    detectFramework(
      ["package.json", "vite.config.ts"],
      pkg({ vue: "3.5.0" }, { vite: "6.0.0" }),
    ),
    "vite",
  );
  assert.equal(
    detectFramework(
      ["package.json"],
      pkg({ "solid-js": "1.9.0" }, { vite: "6.0.0" }),
    ),
    "vite",
  );
  assert.equal(frameworkById("vite")?.defaultPort, 4173);
});

test("a config file at the build root is enough on its own", () => {
  // No manifest at all (or one that declares nothing useful): the file is the
  // signal. `next.config.mjs` cannot belong to anything but Next.js.
  assert.equal(detectFramework(["next.config.mjs"], null), "nextjs");
  assert.equal(detectFramework(["nuxt.config.ts"], null), "nuxt");
  assert.equal(detectFramework(["angular.json"], null), "angular");
  assert.equal(detectFramework(["ASTRO.CONFIG.MJS"], null), "astro");
});

test("a JS app with nothing recognisable is still named Node.js", () => {
  assert.equal(
    detectFramework(["package.json", "server.js"], pkg({ pino: "9.0.0" })),
    "node",
  );
  assert.equal(frameworkById("node")?.name, "Node.js");
});

test("a non-JavaScript repo names no framework", () => {
  assert.equal(detectFramework(["go.mod", "main.go"], null), null);
  assert.equal(detectFramework(["requirements.txt", "app.py"], null), null);
  assert.equal(detectFramework([], null), null);
});

test("only the build root's own files count", () => {
  const tree = [
    "README.md",
    "apps/web/package.json",
    "apps/web/next.config.js",
    "apps/api/package.json",
    "packages/ui/src/index.ts",
  ];
  // At the repo root there is no manifest and no config - a Next.js config three
  // directories down says nothing about what is being deployed.
  assert.deepEqual(rootFileNames(tree), ["readme.md"]);
  assert.equal(detectFramework(rootFileNames(tree), null), null);
  // Pointed at the sub-app, the same tree is unambiguous.
  assert.deepEqual(rootFileNames(tree, "apps/web").sort(), [
    "next.config.js",
    "package.json",
  ]);
  assert.equal(
    detectFramework(rootFileNames(tree, "apps/web"), null),
    "nextjs",
  );
});

test("root-relative path lists are normalised the way trees actually arrive", () => {
  assert.deepEqual(rootFileNames(["./Package.json"]), ["package.json"]);
  assert.deepEqual(rootFileNames(["apps/web/vite.config.ts"], "apps/web/"), [
    "vite.config.ts",
  ]);
  // A root that only PREFIX-matches another directory must not leak into it.
  assert.deepEqual(
    rootFileNames(["apps/web-admin/package.json"], "apps/web"),
    [],
  );
});

test("dependencies are read from both blocks and nowhere else", () => {
  const deps = declaredDependencies({
    dependencies: { next: "15.0.0" },
    devDependencies: { typescript: "5.7.0" },
  });
  assert.deepEqual([...deps].sort(), ["next", "typescript"]);
  // A framework listed only as a peer/optional dependency is not a statement
  // about what the app IS.
  const manifest = { peerDependencies: { next: "15.0.0" } } as never;
  assert.equal(declaredDependencies(manifest).size, 0);
});

test("a hostile or malformed package.json is survivable, never thrown", () => {
  assert.equal(parsePackageManifest("not json at all"), null);
  assert.equal(parsePackageManifest("null"), null);
  assert.equal(parsePackageManifest("[]"), null);
  assert.equal(parsePackageManifest('"a string"'), null);
  assert.deepEqual(parsePackageManifest("{}"), {});
  // Non-object dependency blocks must not crash the walk.
  assert.equal(
    detectFramework(["package.json"], JSON.parse('{"dependencies": "next"}')),
    "node",
  );
});

test("recognition applies to the auto-detecting builders only", () => {
  assert.equal(supportsFrameworkDetection("nixpacks"), true);
  assert.equal(supportsFrameworkDetection("railpack"), true);
  assert.equal(supportsFrameworkDetection("dockerfile"), false);
  assert.equal(supportsFrameworkDetection("static"), false);
});

test("a user's correction outranks detection, and only when it's set", () => {
  assert.equal(
    effectiveFramework({ framework: "nextjs", frameworkOverride: null }),
    "nextjs",
  );
  assert.equal(
    effectiveFramework({ framework: "nextjs", frameworkOverride: "vite" }),
    "vite",
  );
  // A correction on an app detection never named is still the answer.
  assert.equal(
    effectiveFramework({ framework: null, frameworkOverride: "vite" }),
    "vite",
  );
  assert.equal(
    effectiveFramework({ framework: null, frameworkOverride: null }),
    null,
  );
});

test("the catalog itself stays coherent", () => {
  const ids = new Set<string>();
  for (const framework of FRAMEWORKS) {
    assert.ok(!ids.has(framework.id), `duplicate id ${framework.id}`);
    ids.add(framework.id);
    assert.ok(framework.name.length > 0, `${framework.id} has no name`);
    assert.ok(
      Number.isInteger(framework.defaultPort) &&
        framework.defaultPort > 0 &&
        framework.defaultPort <= 65535,
      `${framework.id} has an unusable default port`,
    );
    // Every entry must be reachable by at least one signal, or it can never win.
    assert.ok(
      framework.dependencies.length + framework.files.length > 0,
      `${framework.id} can never match`,
    );
    // Markers are matched lowercase; a capitalised one would never fire.
    for (const file of framework.files) {
      assert.equal(file, file.toLowerCase(), `${framework.id} marker ${file}`);
    }
    assert.equal(isFrameworkId(framework.id), true);
    assert.equal(frameworkById(framework.id)?.name, framework.name);
  }
  assert.equal(isFrameworkId("no-such-framework"), false);
  assert.equal(frameworkById(null), null);
  // The catch-all is last, or it would swallow every JavaScript app.
  assert.equal(FRAMEWORKS[FRAMEWORKS.length - 1].id, "node");
});

test("the package manager comes from the lockfile at the build root", () => {
  assert.equal(packageManagerFrom(["package.json", "bun.lock"]), "bun");
  assert.equal(packageManagerFrom(["package.json", "bun.lockb"]), "bun");
  assert.equal(packageManagerFrom(["pnpm-lock.yaml"]), "pnpm");
  assert.equal(packageManagerFrom(["yarn.lock"]), "yarn");
  assert.equal(packageManagerFrom(["package-lock.json"]), "npm");
  // Nothing to go on is npm, the one that always works.
  assert.equal(packageManagerFrom([]), "npm");
  // The list is matched lowercase, like every other root-file rule.
  assert.equal(packageManagerFrom(["PNPM-LOCK.YAML"]), "pnpm");
});

test("commands come from the repo's own scripts, spelled for its manager", () => {
  const manifest = parsePackageManifest(
    JSON.stringify({ scripts: { build: "next build", start: "next start" } }),
  );
  assert.deepEqual(detectCommands(["pnpm-lock.yaml"], manifest), {
    buildCommand: "pnpm run build",
    startCommand: "pnpm run start",
  });
  // yarn is the one that takes the script name bare.
  assert.deepEqual(detectCommands(["yarn.lock"], manifest), {
    buildCommand: "yarn build",
    startCommand: "yarn start",
  });
});

test("`serve` stands in for a missing `start`", () => {
  const manifest = parsePackageManifest(
    JSON.stringify({ scripts: { serve: "vite preview" } }),
  );
  assert.deepEqual(detectCommands([], manifest), {
    buildCommand: null,
    startCommand: "npm run serve",
  });
});

test("a repo that declares nothing gets no command invented for it", () => {
  // A Go service, a manifest with no scripts, an empty script body, and a
  // scripts block that isn't an object at all - all four say the same thing:
  // nothing, so the builder decides.
  assert.deepEqual(detectCommands(["go.mod"], null), {
    buildCommand: null,
    startCommand: null,
  });
  assert.deepEqual(
    detectCommands([], parsePackageManifest('{"dependencies":{"next":"15"}}')),
    { buildCommand: null, startCommand: null },
  );
  assert.deepEqual(
    detectCommands([], parsePackageManifest('{"scripts":{"build":"   "}}')),
    { buildCommand: null, startCommand: null },
  );
  assert.deepEqual(
    detectCommands([], parsePackageManifest('{"scripts":["build"]}')),
    { buildCommand: null, startCommand: null },
  );
  // A non-string body is user JSON, not a command.
  assert.deepEqual(
    detectCommands([], parsePackageManifest('{"scripts":{"build":42}}')),
    { buildCommand: null, startCommand: null },
  );
});
