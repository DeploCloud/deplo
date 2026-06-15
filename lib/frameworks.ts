/**
 * Framework detection + build presets  the Vercel-style "we figured out your
 * project for you" engine. Pure and isomorphic: used both in the new-project
 * wizard (client preview) and on the server when a deployment is created.
 */
import type { BuildConfig, FrameworkId } from "./types";

export interface FrameworkPreset {
  id: FrameworkId;
  name: string;
  color: string;
  install: string;
  build: string;
  output: string;
  start: string;
  defaultPort: number;
  /** Files whose presence strongly implies this framework. */
  detectFiles?: string[];
  /** package.json dependency names that imply this framework. */
  detectDeps?: string[];
  /** Description shown in tooltips. */
  description: string;
}

export const FRAMEWORKS: Record<FrameworkId, FrameworkPreset> = {
  nextjs: {
    id: "nextjs",
    name: "Next.js",
    color: "#ffffff",
    install: "bun install",
    build: "next build",
    output: ".next",
    start: "next start",
    defaultPort: 3000,
    detectFiles: ["next.config.js", "next.config.ts", "next.config.mjs"],
    detectDeps: ["next"],
    description: "React framework with hybrid static & server rendering.",
  },
  sveltekit: {
    id: "sveltekit",
    name: "SvelteKit",
    color: "#ff3e00",
    install: "bun install",
    build: "vite build",
    output: "build",
    start: "node build",
    defaultPort: 3000,
    detectFiles: ["svelte.config.js"],
    detectDeps: ["@sveltejs/kit"],
    description: "Full-stack Svelte framework powered by Vite.",
  },
  svelte: {
    id: "svelte",
    name: "Svelte",
    color: "#ff3e00",
    install: "bun install",
    build: "vite build",
    output: "dist",
    start: "",
    defaultPort: 3000,
    detectDeps: ["svelte"],
    description: "Cybernetically enhanced web apps.",
  },
  astro: {
    id: "astro",
    name: "Astro",
    color: "#ff5d01",
    install: "bun install",
    build: "astro build",
    output: "dist",
    start: "node ./dist/server/entry.mjs",
    defaultPort: 4321,
    detectFiles: ["astro.config.mjs", "astro.config.ts"],
    detectDeps: ["astro"],
    description: "The web framework for content-driven websites.",
  },
  nuxt: {
    id: "nuxt",
    name: "Nuxt",
    color: "#00dc82",
    install: "bun install",
    build: "nuxt build",
    output: ".output",
    start: "node .output/server/index.mjs",
    defaultPort: 3000,
    detectFiles: ["nuxt.config.ts", "nuxt.config.js"],
    detectDeps: ["nuxt"],
    description: "The intuitive Vue framework.",
  },
  remix: {
    id: "remix",
    name: "Remix",
    color: "#ffffff",
    install: "bun install",
    build: "remix vite:build",
    output: "build",
    start: "remix-serve ./build/server/index.js",
    defaultPort: 3000,
    detectDeps: ["@remix-run/react", "@remix-run/node"],
    description: "Full stack web framework focused on web standards.",
  },
  gatsby: {
    id: "gatsby",
    name: "Gatsby",
    color: "#663399",
    install: "bun install",
    build: "gatsby build",
    output: "public",
    start: "gatsby serve",
    defaultPort: 9000,
    detectFiles: ["gatsby-config.js", "gatsby-config.ts"],
    detectDeps: ["gatsby"],
    description: "React-based static site generator.",
  },
  vite: {
    id: "vite",
    name: "Vite",
    color: "#646cff",
    install: "bun install",
    build: "vite build",
    output: "dist",
    start: "",
    defaultPort: 5173,
    detectFiles: ["vite.config.js", "vite.config.ts"],
    detectDeps: ["vite"],
    description: "Next generation frontend tooling.",
  },
  react: {
    id: "react",
    name: "Create React App",
    color: "#61dafb",
    install: "bun install",
    build: "react-scripts build",
    output: "build",
    start: "",
    defaultPort: 3000,
    detectDeps: ["react-scripts"],
    description: "Single-page React application.",
  },
  vue: {
    id: "vue",
    name: "Vue",
    color: "#42b883",
    install: "bun install",
    build: "vite build",
    output: "dist",
    start: "",
    defaultPort: 5173,
    detectDeps: ["vue"],
    description: "The progressive JavaScript framework.",
  },
  angular: {
    id: "angular",
    name: "Angular",
    color: "#dd0031",
    install: "npm install",
    build: "ng build",
    output: "dist",
    start: "",
    defaultPort: 4200,
    detectFiles: ["angular.json"],
    detectDeps: ["@angular/core"],
    description: "Platform for building mobile and desktop web apps.",
  },
  node: {
    id: "node",
    name: "Node.js",
    color: "#3c873a",
    install: "bun install",
    build: "",
    output: "",
    start: "node index.js",
    defaultPort: 3000,
    detectFiles: ["server.js", "index.js", "app.js"],
    description: "Generic Node.js server application.",
  },
  python: {
    id: "python",
    name: "Python",
    color: "#3776ab",
    install: "pip install -r requirements.txt",
    build: "",
    output: "",
    start: "gunicorn app:app",
    defaultPort: 8000,
    detectFiles: ["requirements.txt", "pyproject.toml", "Pipfile"],
    description: "Python web app (Flask, FastAPI, Django…).",
  },
  go: {
    id: "go",
    name: "Go",
    color: "#00add8",
    install: "go mod download",
    build: "go build -o app",
    output: "app",
    start: "./app",
    defaultPort: 8080,
    detectFiles: ["go.mod"],
    description: "Compiled Go web service.",
  },
  rust: {
    id: "rust",
    name: "Rust",
    color: "#dea584",
    install: "cargo fetch",
    build: "cargo build --release",
    output: "target/release",
    start: "./target/release/app",
    defaultPort: 8080,
    detectFiles: ["Cargo.toml"],
    description: "Compiled Rust web service.",
  },
  php: {
    id: "php",
    name: "PHP",
    color: "#777bb4",
    install: "composer install",
    build: "",
    output: "",
    start: "php -S 0.0.0.0:8080",
    defaultPort: 8080,
    detectFiles: ["composer.json", "index.php"],
    description: "PHP application (Laravel, Symfony…).",
  },
  docker: {
    id: "docker",
    name: "Dockerfile",
    color: "#2496ed",
    install: "",
    build: "docker build",
    output: "",
    start: "",
    defaultPort: 3000,
    detectFiles: ["Dockerfile"],
    description: "Build straight from your Dockerfile.",
  },
  static: {
    id: "static",
    name: "Static HTML",
    color: "#e34f26",
    install: "",
    build: "",
    output: "./",
    start: "",
    defaultPort: 80,
    detectFiles: ["index.html"],
    description: "Plain static site served by Nginx.",
  },
  other: {
    id: "other",
    name: "Other",
    color: "#888888",
    install: "bun install",
    build: "bun run build",
    output: "dist",
    start: "bun run start",
    defaultPort: 3000,
    description: "Custom build configuration.",
  },
};

export const FRAMEWORK_LIST = Object.values(FRAMEWORKS);

/** A simplified repository manifest used for detection. */
export interface RepoManifest {
  files: string[];
  packageJson?: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  } | null;
}

/**
 * Detect the framework from a repository manifest (file list + package.json).
 * Mirrors Vercel's auto-detection ordering: most-specific framework wins.
 */
export function detectFramework(manifest: RepoManifest): FrameworkId {
  const files = new Set(manifest.files.map((f) => f.toLowerCase()));
  const deps = {
    ...(manifest.packageJson?.dependencies || {}),
    ...(manifest.packageJson?.devDependencies || {}),
  };
  const hasDep = (name: string) =>
    name.toLowerCase() in
    Object.fromEntries(Object.keys(deps).map((k) => [k.toLowerCase(), true]));

  // Order matters: meta-frameworks before their underlying libraries.
  const order: FrameworkId[] = [
    "nextjs",
    "nuxt",
    "sveltekit",
    "astro",
    "remix",
    "gatsby",
    "angular",
    "react",
    "vue",
    "svelte",
    "vite",
    "docker",
    "go",
    "rust",
    "python",
    "php",
    "node",
    "static",
  ];

  for (const id of order) {
    const p = FRAMEWORKS[id];
    if (p.detectDeps?.some(hasDep)) return id;
    if (p.detectFiles?.some((f) => files.has(f.toLowerCase()))) return id;
  }
  return "other";
}

/** Build a full BuildConfig from a detected framework + overrides. */
export function buildConfigFor(
  framework: FrameworkId,
  overrides: Partial<BuildConfig> = {},
): BuildConfig {
  const p = FRAMEWORKS[framework];
  return {
    framework,
    rootDirectory: "./",
    installCommand: p.install,
    buildCommand: p.build,
    outputDirectory: p.output,
    startCommand: p.start,
    nodeVersion: "22.x",
    port: p.defaultPort,
    ...overrides,
  };
}
