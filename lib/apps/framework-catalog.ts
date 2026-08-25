/**
 * The JavaScript frameworks Deplo recognises in an app's own source, and the one
 * thing it derives from each: the port that framework's production server listens
 * on out of the box.
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
   * otherwise.
   */
  defaultPort: number;
}

/**
 * Every framework, in DETECTION PRIORITY ORDER — the first match wins, so the list
 * runs most-specific to least. Two orderings carry real weight: - Meta-frameworks
 * before the libraries they build on. - Frontend/fullstack before backend.
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
    dependencies: [
      "@react-router/dev",
      "@react-router/node",
      "@react-router/serve",
    ],
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
    dependencies: [
      "@builder.io/qwik-city",
      "@builder.io/qwik",
      "@qwik.dev/core",
    ],
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
    // Vue CLI specifically.
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
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** Narrow an untrusted string to a catalog id. */
export function isFrameworkId(value: string): value is FrameworkId {
  return BY_ID.has(value);
}

/**
 * The framework an app actually IS: the user's correction when they made one,
 * otherwise what the last deploy read from the source. has exactly one answer and
 * a stale override can never outlive being cleared.
 */
export function effectiveFramework(app: {
  framework: string | null;
  frameworkOverride: string | null;
}): string | null {
  return app.frameworkOverride ?? app.framework;
}

/**
 * Whether framework recognition applies to a build method at all. With a
 * Dockerfile or the static builder the user has already spelled the build out;
 * detection there would be a label that changes nothing.
 */
export function supportsFrameworkDetection(method: BuildMethod): boolean {
  return method === "nixpacks" || method === "railpack";
}
