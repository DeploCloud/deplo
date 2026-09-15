import test from "node:test";
import assert from "node:assert/strict";

import {
  angularOutputDir,
  declaredDependencies,
  frameworkDefaults,
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
  assert.deepEqual(rootFileNames(tree), ["readme.md"]);
  assert.equal(detectFramework(rootFileNames(tree), null), null);
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
  const manifest = { peerDependencies: { next: "15.0.0" } } as never;
  assert.equal(declaredDependencies(manifest).size, 0);
});

test("a hostile or malformed package.json is survivable, never thrown", () => {
  assert.equal(parsePackageManifest("not json at all"), null);
  assert.equal(parsePackageManifest("null"), null);
  assert.equal(parsePackageManifest("[]"), null);
  assert.equal(parsePackageManifest('"a string"'), null);
  assert.deepEqual(parsePackageManifest("{}"), {});
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
  assert.equal(
    effectiveFramework({ framework: null, frameworkOverride: "vite" }),
    "vite",
  );
  assert.equal(
    effectiveFramework({ framework: null, frameworkOverride: null }),
    null,
  );
});

test("a framework gets a start only where no builder derives one", () => {
  const none = new Set<string>();
  assert.deepEqual(
    frameworkDefaults("sveltekit", new Set(["@sveltejs/adapter-node"])),
    {
      staticOutput: null,
      startCommand: "node build",
    },
  );
  assert.deepEqual(
    frameworkDefaults("sveltekit", new Set(["@sveltejs/adapter-static"])),
    {
      staticOutput: "build",
      startCommand: null,
    },
  );
  assert.deepEqual(
    frameworkDefaults("sveltekit", new Set(["@sveltejs/adapter-auto"])),
    {
      staticOutput: null,
      startCommand: null,
    },
  );
  assert.equal(
    frameworkDefaults("adonisjs", none).startCommand,
    "node build/bin/server.js",
  );
  for (const id of ["nextjs", "vite", "express", "astro", null] as const) {
    assert.deepEqual(frameworkDefaults(id, none), {
      staticOutput: null,
      startCommand: null,
    });
  }
});

test("an Angular workspace's output directory carries its project name", () => {
  const modern = JSON.stringify({
    projects: {
      shop: { targets: { build: { builder: "@angular/build:application" } } },
    },
  });
  assert.equal(angularOutputDir(modern), "dist/shop/browser");

  const legacy = JSON.stringify({
    projects: {
      shop: {
        architect: {
          build: {
            builder: "@angular-devkit/build-angular:browser",
            options: { outputPath: "dist/web" },
          },
        },
      },
    },
  });
  assert.equal(angularOutputDir(legacy), "dist/web");

  const pair = JSON.stringify({
    defaultProject: "b",
    projects: {
      a: { targets: { build: { builder: "@angular/build:application" } } },
      b: {
        targets: {
          build: {
            builder: "@angular/build:application",
            options: { outputPath: { base: "out" } },
          },
        },
      },
    },
  });
  assert.equal(angularOutputDir(pair), "out/browser");

  assert.equal(angularOutputDir("not json"), null);
  assert.equal(angularOutputDir("{}"), null);
  assert.equal(
    angularOutputDir(
      JSON.stringify({
        projects: {
          a: { targets: { build: { options: { outputPath: "../x" } } } },
        },
      }),
    ),
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
    assert.ok(
      framework.dependencies.length + framework.files.length > 0,
      `${framework.id} can never match`,
    );
    for (const file of framework.files) {
      assert.equal(file, file.toLowerCase(), `${framework.id} marker ${file}`);
    }
    if (framework.staticOutput !== undefined) {
      assert.match(
        framework.staticOutput,
        /^[\w.][\w./-]*$/,
        `${framework.id} has an unusable static output`,
      );
      assert.ok(!framework.staticOutput.includes(".."), framework.id);
    }
    assert.equal(isFrameworkId(framework.id), true);
    assert.equal(frameworkById(framework.id)?.name, framework.name);
  }
  assert.equal(isFrameworkId("no-such-framework"), false);
  assert.equal(frameworkById(null), null);
  assert.equal(FRAMEWORKS[FRAMEWORKS.length - 1].id, "node");
});

test("the package manager comes from the lockfile at the build root", () => {
  assert.equal(packageManagerFrom(["package.json", "bun.lock"]), "bun");
  assert.equal(packageManagerFrom(["package.json", "bun.lockb"]), "bun");
  assert.equal(packageManagerFrom(["pnpm-lock.yaml"]), "pnpm");
  assert.equal(packageManagerFrom(["yarn.lock"]), "yarn");
  assert.equal(packageManagerFrom(["package-lock.json"]), "npm");
  assert.equal(packageManagerFrom([]), "npm");
  assert.equal(packageManagerFrom(["PNPM-LOCK.YAML"]), "pnpm");
});

test("the build command comes from the repo's own script, spelled for its manager", () => {
  const manifest = parsePackageManifest(
    JSON.stringify({ scripts: { build: "next build", start: "next start" } }),
  );
  assert.deepEqual(detectCommands(["pnpm-lock.yaml"], manifest), {
    buildCommand: "pnpm run build",
  });
  assert.deepEqual(detectCommands(["yarn.lock"], manifest), {
    buildCommand: "yarn build",
  });
});

test("a start script is never promoted to the app's start command", () => {
  for (const start of [
    "gatsby develop",
    "ng serve",
    "docusaurus start",
    "vite",
  ]) {
    const manifest = parsePackageManifest(
      JSON.stringify({
        scripts: { build: "x build", start, serve: "x serve" },
      }),
    );
    assert.deepEqual(detectCommands([], manifest), {
      buildCommand: "npm run build",
    });
  }
});

test("a repo that declares nothing gets no command invented for it", () => {
  assert.deepEqual(detectCommands(["go.mod"], null), { buildCommand: null });
  assert.deepEqual(
    detectCommands([], parsePackageManifest('{"dependencies":{"next":"15"}}')),
    { buildCommand: null },
  );
  assert.deepEqual(
    detectCommands([], parsePackageManifest('{"scripts":{"build":"   "}}')),
    { buildCommand: null },
  );
  assert.deepEqual(
    detectCommands([], parsePackageManifest('{"scripts":["build"]}')),
    { buildCommand: null },
  );
  assert.deepEqual(
    detectCommands([], parsePackageManifest('{"scripts":{"build":42}}')),
    { buildCommand: null },
  );
});
