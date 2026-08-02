/**
 * The JavaScript frameworks Deplo recognises in an app's own source, and the one
 * thing it derives from each: the port that framework's production server
 * listens on out of the box.
 *
 * This is RECOGNITION, not a preset. Deplo does not (and must not) write
 * install/build/start commands from a framework — the auto-detecting builders
 * own that, which is exactly why the old user-picked "framework preset" was
 * removed (see {@link file://../frameworks.ts}). What the user gets here is the
 * Vercel moment: the platform says "this is a Next.js app" with the project's
 * real mark, and the container port stops being a number they have to know.
 *
 * Consequences of that scope, deliberately:
 *  - Detection is READ-ONLY over the source and never changes how a build runs.
 *  - It only means anything under the builders that auto-detect a stack
 *    (Nixpacks / Railpack) — see {@link supportsFrameworkDetection}. A Dockerfile
 *    or the static builder is the user telling Deplo exactly how to build; naming
 *    a framework there would be decoration that changes nothing.
 *  - The user CAN correct it (`apps.framework_override`, read through
 *    {@link effectiveFramework}). Detection is a heuristic over a `package.json`,
 *    and where it guesses wrong it guesses wrong about the PORT — a Vite SPA that
 *    still carries `next` deploys green on 3000 and answers nothing on 4173. The
 *    correction changes the name and the port default; it still writes no build
 *    commands, which remains the auto-detecting builders' job alone.
 *
 * Pure and isomorphic: the detector (server) and the UI (client) both read this,
 * so the badge and the port can never disagree about what was found.
 */
import type { BuildMethod } from "../types";

/**
 * A recognised framework. Ids are stable — they are persisted on the app row and
 * key the brand marks in `components/shared/framework-icons.tsx`, so renaming one
 * silently drops the icon for every app already carrying it.
 */
export type FrameworkId =
  | "nextjs"
  | "nuxt"
  | "sveltekit"
  | "astro"
  | "remix"
  | "react-router"
  | "docusaurus"
  | "gatsby"
  | "angular"
  | "nestjs"
  | "adonisjs"
  | "strapi"
  | "qwik"
  | "solid"
  | "eleventy"
  | "vue"
  | "preact"
  | "svelte"
  | "cra"
  | "vite"
  | "express"
  | "fastify"
  | "hono"
  | "koa"
  | "node";

export interface FrameworkDefinition {
  id: FrameworkId;
  /** Display name, spelled the way the project spells it. */
  name: string;
  /**
   * `package.json` dependency names that identify it — ANY match is a hit.
   * Read from `dependencies` + `devDependencies` only (a transitive dep is not a
   * statement about what the app IS).
   */
  dependencies: readonly string[];
  /**
   * Config filenames at the build root that identify it — ANY match is a hit.
   * Lowercase, and matched only at the root (a `next.config.js` buried in an
   * example dir says nothing about the app being deployed).
   */
  files: readonly string[];
  /**
   * The port this framework's production server binds when nothing tells it
   * otherwise. Deplo injects `PORT` into the container, which most of these
   * honour — but the ones that DON'T (`vite preview` on 4173, `ng serve` on
   * 4200) are precisely the apps that deploy green and then answer nothing on
   * :3000, so the default is worth getting right per framework.
   */
  defaultPort: number;
}

/**
 * Every framework, in DETECTION PRIORITY ORDER — the first match wins, so the
 * list runs most-specific to least. Two orderings carry real weight:
 *
 *  - Meta-frameworks before the libraries they build on. A Next.js app depends on
 *    `react`, a Nuxt app on `vue`, a SvelteKit app on `svelte`, an Astro or
 *    SolidStart app on `vite` — matching the base library first would report the
 *    ingredient instead of the dish.
 *  - Frontend/fullstack before backend. A fullstack app routinely carries
 *    `express` for a custom server; a plain Express API never carries `next`.
 *
 * `node` is last and matches any `package.json`: "we know it's a Node app, we
 * just can't name the framework" is a truthful answer, and a better one than a
 * blank space.
 */
export const FRAMEWORKS: readonly FrameworkDefinition[] = [
  {
    id: "nextjs",
    name: "Next.js",
    dependencies: ["next"],
    files: [
      "next.config.js",
      "next.config.mjs",
      "next.config.cjs",
      "next.config.ts",
    ],
    defaultPort: 3000,
  },
  {
    id: "nuxt",
    name: "Nuxt",
    dependencies: ["nuxt", "nuxt3", "nuxt-edge"],
    files: ["nuxt.config.js", "nuxt.config.mjs", "nuxt.config.ts"],
    defaultPort: 3000,
  },
  {
    id: "sveltekit",
    name: "SvelteKit",
    dependencies: ["@sveltejs/kit"],
    files: [],
    defaultPort: 3000,
  },
  {
    id: "astro",
    name: "Astro",
    dependencies: ["astro"],
    files: ["astro.config.js", "astro.config.mjs", "astro.config.ts"],
    defaultPort: 4321,
  },
  {
    id: "remix",
    name: "Remix",
    dependencies: ["@remix-run/dev", "@remix-run/node", "@remix-run/serve"],
    files: ["remix.config.js", "remix.config.mjs", "remix.config.ts"],
    defaultPort: 3000,
  },
  {
    // Remix v3 shipped as React Router v7 — a different framework name, same
    // lineage, and it is what a repo scaffolded today carries.
    id: "react-router",
    name: "React Router",
    dependencies: ["@react-router/dev", "@react-router/node", "@react-router/serve"],
    files: ["react-router.config.js", "react-router.config.ts"],
    defaultPort: 3000,
  },
  {
    id: "docusaurus",
    name: "Docusaurus",
    dependencies: ["@docusaurus/core"],
    files: ["docusaurus.config.js", "docusaurus.config.ts"],
    defaultPort: 3000,
  },
  {
    id: "gatsby",
    name: "Gatsby",
    dependencies: ["gatsby"],
    files: ["gatsby-config.js", "gatsby-config.mjs", "gatsby-config.ts"],
    // `gatsby serve` binds 9000, not the 8000 of `gatsby develop`.
    defaultPort: 9000,
  },
  {
    id: "angular",
    name: "Angular",
    dependencies: ["@angular/core"],
    files: ["angular.json"],
    defaultPort: 4200,
  },
  {
    id: "nestjs",
    name: "NestJS",
    dependencies: ["@nestjs/core"],
    files: ["nest-cli.json"],
    defaultPort: 3000,
  },
  {
    id: "adonisjs",
    name: "AdonisJS",
    dependencies: ["@adonisjs/core"],
    files: ["adonisrc.ts", "adonisrc.js", ".adonisrc.json"],
    defaultPort: 3333,
  },
  {
    id: "strapi",
    name: "Strapi",
    dependencies: ["@strapi/strapi", "strapi"],
    files: [],
    defaultPort: 1337,
  },
  {
    id: "qwik",
    name: "Qwik",
    dependencies: ["@builder.io/qwik-city", "@builder.io/qwik", "@qwik.dev/core"],
    files: [],
    defaultPort: 3000,
  },
  {
    id: "solid",
    name: "SolidStart",
    // SolidStart (a server), NOT a bare `solid-js` SPA: that one is a Vite
    // project served by `vite preview`, so it belongs to Vite's entry and Vite's
    // port. Same rule as Vue below.
    dependencies: ["@solidjs/start", "solid-start"],
    files: [],
    defaultPort: 3000,
  },
  {
    id: "eleventy",
    name: "Eleventy",
    dependencies: ["@11ty/eleventy"],
    files: [".eleventy.js", "eleventy.config.js", "eleventy.config.mjs"],
    defaultPort: 8080,
  },
  {
    // Vue CLI specifically. A Vue 3 app scaffolded today is a Vite project and
    // is reported as Vite — an entry earns its place only when its PORT is
    // unambiguous, and a bare `vue` dependency spans two servers on two ports
    // (`vue-cli-service serve` on 8080, `vite preview` on 4173).
    id: "vue",
    name: "Vue",
    dependencies: ["@vue/cli-service"],
    files: ["vue.config.js"],
    defaultPort: 8080,
  },
  {
    id: "preact",
    name: "Preact",
    // Bare `preact` is safe to name: every current Preact scaffold is a Vite
    // project, so the port is the same either way.
    dependencies: ["preact"],
    files: [],
    defaultPort: 4173,
  },
  {
    id: "svelte",
    name: "Svelte",
    dependencies: ["svelte"],
    files: ["svelte.config.js"],
    defaultPort: 4173,
  },
  {
    id: "cra",
    name: "Create React App",
    // `react-scripts`, never a bare `react`: every React meta-framework above
    // depends on react, so the bare package identifies nothing.
    dependencies: ["react-scripts"],
    files: [],
    defaultPort: 3000,
  },
  {
    id: "vite",
    name: "Vite",
    dependencies: ["vite"],
    files: ["vite.config.js", "vite.config.mjs", "vite.config.ts"],
    // `vite preview` binds 4173 and ignores PORT — one of the two frameworks
    // this whole registry exists to get right.
    defaultPort: 4173,
  },
  {
    id: "express",
    name: "Express",
    dependencies: ["express"],
    files: [],
    defaultPort: 3000,
  },
  {
    id: "fastify",
    name: "Fastify",
    dependencies: ["fastify"],
    files: [],
    defaultPort: 3000,
  },
  {
    id: "hono",
    name: "Hono",
    dependencies: ["hono"],
    files: [],
    defaultPort: 3000,
  },
  {
    id: "koa",
    name: "Koa",
    dependencies: ["koa"],
    files: [],
    defaultPort: 3000,
  },
  {
    id: "node",
    name: "Node.js",
    // The catch-all: no dependency names it, the presence of a manifest does.
    dependencies: [],
    files: ["package.json"],
    defaultPort: 3000,
  },
];

const BY_ID = new Map<string, FrameworkDefinition>(
  FRAMEWORKS.map((f) => [f.id, f]),
);

/** The definition for a stored id, or null when the id is unknown (an app row
 * written by a newer/older catalog than the one running). */
export function frameworkById(
  id: string | null | undefined,
): FrameworkDefinition | null {
  return id ? BY_ID.get(id) ?? null : null;
}

/** Narrow an untrusted string to a catalog id. */
export function isFrameworkId(value: string): value is FrameworkId {
  return BY_ID.has(value);
}

/**
 * The framework an app actually IS: the user's correction when they made one,
 * otherwise what the last deploy read from the source. The single reader — the
 * badge, the settings card and the API all go through it, so "which one wins?"
 * has exactly one answer and a stale override can never outlive being cleared.
 */
export function effectiveFramework(app: {
  framework: string | null;
  frameworkOverride: string | null;
}): string | null {
  return app.frameworkOverride ?? app.framework;
}

/**
 * Whether framework recognition applies to a build method at all. TRUE only for
 * the builders that auto-detect the stack themselves (Nixpacks, Railpack): those
 * are the ones where Deplo — not the user — decides how the app is built, so
 * naming the framework and defaulting its port is Deplo doing its job. With a
 * Dockerfile or the static builder the user has already spelled the build out;
 * detection there would be a label that changes nothing.
 *
 * The single gate — the deploy hook, the API and every piece of UI read it, so
 * "when is this on?" has exactly one answer.
 */
export function supportsFrameworkDetection(method: BuildMethod): boolean {
  return method === "nixpacks" || method === "railpack";
}
