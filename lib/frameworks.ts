/**
 * Framework detection + build presets  the Vercel-style "we figured out your
 * project for you" engine. Pure and isomorphic: used both in the new-project
 * wizard (client preview) and on the server when a deployment is created.
 */
import type {
  BuildConfig,
  BuildMethod,
  DevImagePreset,
  FrameworkId,
} from "./types";

export interface FrameworkPreset {
  id: FrameworkId;
  name: string;
  color: string;
  install: string;
  build: string;
  output: string;
  start: string;
  /**
   * Dev-server command for dev mode (e.g. "next dev"). Run inside the dev
   * container as `devuser`; `$PORT`/`-p $PORT` is appended by the dev entrypoint
   * where the framework's CLI accepts it. Empty ⇒ no canonical dev server (the
   * user supplies one). A *different axis* from `start` (production).
   */
  dev: string;
  defaultPort: number;
  /** Files whose presence strongly implies this framework. */
  detectFiles?: string[];
  /** package.json dependency names that imply this framework. */
  detectDeps?: string[];
  /** Description shown in tooltips. */
  description: string;
}

/**
 * The runtime a framework builds on. Drives the language-aware version field
 * (e.g. "Node.js Version" vs "Python Version") shown in build settings. `none`
 * means there is no Deplo-controllable runtime version (static HTML, or a
 * Dockerfile/buildpack that picks its own runtime).
 */
export type RuntimeLanguage = "node" | "python" | "go" | "rust" | "php" | "none";

interface RuntimeInfo {
  language: RuntimeLanguage;
  /** Field label shown in the UI, e.g. "Node.js Version". */
  versionLabel: string;
  /** Default version string seeded into BuildConfig.runtimeVersion. */
  defaultVersion: string;
}

const NODE_RUNTIME: RuntimeInfo = {
  language: "node",
  versionLabel: "Node.js Version",
  defaultVersion: "22.x",
};

/** Map a framework to the runtime whose version the user can pin. */
const FRAMEWORK_RUNTIME: Record<FrameworkId, RuntimeInfo> = {
  nextjs: NODE_RUNTIME,
  svelte: NODE_RUNTIME,
  sveltekit: NODE_RUNTIME,
  astro: NODE_RUNTIME,
  vite: NODE_RUNTIME,
  remix: NODE_RUNTIME,
  nuxt: NODE_RUNTIME,
  react: NODE_RUNTIME,
  vue: NODE_RUNTIME,
  angular: NODE_RUNTIME,
  gatsby: NODE_RUNTIME,
  node: NODE_RUNTIME,
  python: { language: "python", versionLabel: "Python Version", defaultVersion: "3.12" },
  go: { language: "go", versionLabel: "Go Version", defaultVersion: "1.22" },
  rust: { language: "rust", versionLabel: "Rust Version", defaultVersion: "1.79" },
  php: { language: "php", versionLabel: "PHP Version", defaultVersion: "8.3" },
  // No Deplo-controllable runtime version: static is just files; docker/other
  // let the Dockerfile or builder choose the runtime.
  static: { language: "none", versionLabel: "", defaultVersion: "" },
  docker: { language: "none", versionLabel: "", defaultVersion: "" },
  other: { language: "none", versionLabel: "", defaultVersion: "" },
};

/** The runtime info (language, version label + default) for a framework. */
export function runtimeFor(framework: FrameworkId): RuntimeInfo {
  return FRAMEWORK_RUNTIME[framework] ?? FRAMEWORK_RUNTIME.other;
}

/**
 * The dev-server command for a framework (e.g. "next dev"). Empty when the
 * framework has no canonical dev server (docker/static); callers fall back to a
 * user-supplied command. A *different axis* from the production `start` command.
 */
export function devCommandFor(framework: FrameworkId): string {
  return (FRAMEWORKS[framework] ?? FRAMEWORKS.other).dev;
}

/**
 * Official base image each dev image preset resolves to (ADR-0004). Used
 * directly — Deplo builds no per-language dev images. `node` is the safe
 * fallback for frameworks with no Deplo-controllable runtime (the JS toolchain
 * covers most source-bearing services).
 */
export const DEV_PRESET_IMAGE: Record<DevImagePreset, string> = {
  node: "node:22",
  python: "python:3.12",
  go: "golang:1.23",
  rust: "rust:1",
  php: "php:8.3",
  java: "eclipse-temurin:21",
};

/**
 * Derive the dev image preset from a framework's runtime language (ADR-0004).
 * A *coarser* axis than `framework`: a Next.js project derives `node`. There is
 * no `java` framework today, so the preset is only ever reached via a custom
 * image, but it is a valid preset id. Languages with no Deplo-controllable
 * runtime (`none` → static/docker/other) fall back to `node`.
 */
export function devImagePresetFor(framework: FrameworkId): DevImagePreset {
  const lang = runtimeFor(framework).language;
  switch (lang) {
    case "python":
      return "python";
    case "go":
      return "go";
    case "rust":
      return "rust";
    case "php":
      return "php";
    case "node":
    case "none":
    default:
      return "node";
  }
}

/** Resolve a dev image preset id to the official base image it runs on. */
export function devPresetImage(preset: DevImagePreset): string {
  return DEV_PRESET_IMAGE[preset] ?? DEV_PRESET_IMAGE.node;
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
    dev: "next dev",
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
    dev: "vite dev",
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
    dev: "vite dev",
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
    dev: "astro dev",
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
    dev: "nuxt dev",
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
    dev: "remix vite:dev",
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
    dev: "gatsby develop -H 0.0.0.0",
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
    dev: "vite",
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
    dev: "react-scripts start",
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
    dev: "vite",
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
    dev: "ng serve --host 0.0.0.0",
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
    dev: "node index.js",
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
    dev: "python -m flask run --host 0.0.0.0 --reload",
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
    dev: "go run .",
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
    dev: "cargo run",
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
    dev: "php -S 0.0.0.0:8080",
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
    dev: "",
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
    dev: "",
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
    dev: "bun run dev",
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

/**
 * The build method a framework preset implies by default. A repo with its own
 * Dockerfile builds from it; a static site is served by nginx; everything else
 * is auto-detected and built by Nixpacks (no Dockerfile authoring required).
 */
export function defaultBuildMethod(framework: FrameworkId): BuildMethod {
  if (framework === "docker") return "dockerfile";
  if (framework === "static") return "static";
  return "nixpacks";
}

/**
 * Backfill build-method fields on a BuildConfig read from the store. Services
 * created before build methods existed have no `buildMethod`/`methodSettings`;
 * derive sane defaults from the framework so old services keep deploying and the
 * settings form renders. Pure and idempotent — safe to call on every read.
 */
export function normalizeBuildConfig(build: BuildConfig): BuildConfig {
  // Migrate the legacy `nodeVersion` field to the language-neutral
  // `runtimeVersion` (older services stored only `nodeVersion`).
  const legacyVersion = (build as { nodeVersion?: string }).nodeVersion;
  const withRuntime: BuildConfig =
    build.runtimeVersion == null && legacyVersion != null
      ? { ...build, runtimeVersion: legacyVersion }
      : build;

  if (withRuntime.buildMethod && withRuntime.methodSettings) return withRuntime;
  const seeded = buildConfigFor(withRuntime.framework, withRuntime);
  return {
    ...seeded,
    methodSettings: { ...seeded.methodSettings, ...withRuntime.methodSettings },
  };
}

/** Build a full BuildConfig from a detected framework + overrides. */
export function buildConfigFor(
  framework: FrameworkId,
  overrides: Partial<BuildConfig> = {},
): BuildConfig {
  const p = FRAMEWORKS[framework];
  const buildMethod = overrides.buildMethod ?? defaultBuildMethod(framework);
  return {
    framework,
    buildMethod,
    methodSettings: {
      dockerfilePath: "Dockerfile",
      dockerContextPath: ".",
      railpackVersion: "latest",
      herokuVersion: "24",
      // Only seed a publish dir for frameworks with no start command (true
      // static sites: vite/react/vue/angular/svelte/static). Server runtimes
      // (next/nuxt/sveltekit/remix/astro/gatsby/go/rust) must run their start
      // command — a non-empty publish dir forces buildNixpacks down the nginx
      // static-wrap path, which cannot serve an SSR build artifact like .next.
      nixpacksPublishDirectory: p.start ? undefined : p.output || undefined,
      staticSinglePageApp: false,
      ...overrides.methodSettings,
    },
    rootDirectory: "./",
    installCommand: p.install,
    buildCommand: p.build,
    outputDirectory: p.output,
    startCommand: p.start,
    runtimeVersion: runtimeFor(framework).defaultVersion,
    port: p.defaultPort,
    ...overrides,
  };
}
