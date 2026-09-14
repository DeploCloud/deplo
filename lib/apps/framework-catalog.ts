import type { BuildMethod } from "../types/build";

// FrameworkId - stable ids: they are persisted on the app row and key the brand marks.
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
  name: string;
  dependencies: readonly string[];
  files: readonly string[];
  defaultPort: number;
  staticOutput?: string;
}

// FRAMEWORKS - every framework in detection priority order; the first match wins, so most-specific comes first.
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
    staticOutput: "build",
  },
  {
    id: "gatsby",
    name: "Gatsby",
    dependencies: ["gatsby"],
    files: ["gatsby-config.js", "gatsby-config.mjs", "gatsby-config.ts"],
    // `gatsby serve` binds 9000, not the 8000 of `gatsby develop`.
    defaultPort: 9000,
    staticOutput: "public",
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
    // SolidStart (a server), not a bare solid-js SPA: that one is Vite's entry and Vite's port.
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
    staticOutput: "_site",
  },
  {
    id: "vue",
    name: "Vue",
    dependencies: ["@vue/cli-service"],
    files: ["vue.config.js"],
    defaultPort: 8080,
    staticOutput: "dist",
  },
  {
    id: "preact",
    name: "Preact",
    // Bare `preact` is safe to name: every current Preact scaffold is a Vite project.
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
    // `react-scripts`, never a bare `react`: every React meta-framework above depends on react.
    dependencies: ["react-scripts"],
    files: [],
    defaultPort: 3000,
  },
  {
    id: "vite",
    name: "Vite",
    dependencies: ["vite"],
    files: ["vite.config.js", "vite.config.mjs", "vite.config.ts"],
    // `vite preview` binds 4173 and ignores PORT.
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
    dependencies: [],
    files: ["package.json"],
    defaultPort: 3000,
  },
];

const BY_ID = new Map<string, FrameworkDefinition>(
  FRAMEWORKS.map((f) => [f.id, f]),
);

// frameworkById - the definition for a stored id, or null when the id is unknown.
export function frameworkById(
  id: string | null | undefined,
): FrameworkDefinition | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

// isFrameworkId - narrow an untrusted string to a catalog id.
export function isFrameworkId(value: string): value is FrameworkId {
  return BY_ID.has(value);
}

// effectiveFramework - the user's correction when they made one, otherwise what the last deploy read.
export function effectiveFramework(app: {
  framework: string | null;
  frameworkOverride: string | null;
}): string | null {
  return app.frameworkOverride ?? app.framework;
}

// supportsFrameworkDetection - whether recognition applies at all; a Dockerfile already spells the build out.
export function supportsFrameworkDetection(method: BuildMethod): boolean {
  return method === "nixpacks" || method === "railpack";
}
