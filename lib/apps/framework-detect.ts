/**
 * Pure framework recognition: given the files at an app's build root and its
 * parsed `package.json`, name the framework from the {@link
 * file://./framework-catalog.ts} registry.
 */
import { FRAMEWORKS, type FrameworkId } from "./framework-catalog";

/** The `package.json` fields recognition reads. Everything is optional - the
 * file is arbitrary user JSON, not a contract. */
export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/**
 * Parse a `package.json` payload, or null when it is not a JSON object. Note
 * `JSON.parse("null")` and `JSON.parse("[]")` both succeed, so the shape is
 * checked rather than assumed - a repo can ship anything under that name.
 */
export function parsePackageManifest(text: string): PackageManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as PackageManifest;
}

/**
 * The DIRECT dependency names declared by a manifest - `dependencies` plus
 * `devDependencies`, which is where a framework always sits (Vite, Astro and
 * SvelteKit live in devDependencies; Next and Express in dependencies).
 */
export function declaredDependencies(
  manifest: PackageManifest | null | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const block of [manifest?.dependencies, manifest?.devDependencies]) {
    if (!block || typeof block !== "object") continue;
    for (const name of Object.keys(block)) names.add(name);
  }
  return names;
}

/**
 * The file names sitting DIRECTLY in the build root, taken from a repo-root
 * relative path list (a recursive git tree, a directory walk).
 */
export function rootFileNames(
  paths: readonly string[],
  rootRel = "",
): string[] {
  const prefix =
    rootRel && rootRel !== "." ? `${rootRel.replace(/\/+$/, "")}/` : "";
  const out: string[] = [];
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (prefix) {
      if (!normalized.startsWith(prefix)) continue;
      const rest = normalized.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      out.push(rest.toLowerCase());
    } else {
      if (normalized.includes("/")) continue;
      out.push(normalized.toLowerCase());
    }
  }
  return out;
}

/** The package managers a lockfile at the build root can name. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Lockfile → manager, most specific first. Same priority the generated
 * Dockerfile's install step uses. */
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

/**
 * Which package manager runs this build root's scripts, from the lockfile it
 * ships. npm when nothing says otherwise - it is the one that always works.
 */
export function packageManagerFrom(
  rootFiles: readonly string[],
): PackageManager {
  const files = new Set(rootFiles.map((f) => f.toLowerCase()));
  for (const [file, manager] of LOCKFILES) if (files.has(file)) return manager;
  return "npm";
}

/** The commands a repository declares for itself, or null where it declares none. */
export interface DetectedCommands {
  buildCommand: string | null;
  startCommand: string | null;
}

const NO_COMMANDS: DetectedCommands = {
  buildCommand: null,
  startCommand: null,
};

/**
 * The build and start commands a repository declares in its OWN `package.json`,
 * spelled for its own package manager. Never invented from the framework: a null
 * means the repo said nothing and the builder decides.
 */
export function detectCommands(
  rootFiles: readonly string[],
  manifest: PackageManifest | null | undefined,
): DetectedCommands {
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return NO_COMMANDS;
  }
  const manager = packageManagerFrom(rootFiles);
  return {
    buildCommand: runScript(manager, scripts, "build"),
    startCommand:
      runScript(manager, scripts, "start") ??
      runScript(manager, scripts, "serve"),
  };
}

function runScript(
  manager: PackageManager,
  scripts: Record<string, string>,
  name: string,
): string | null {
  const body = scripts[name];
  if (typeof body !== "string" || body.trim() === "") return null;
  // `yarn build` is how yarn spells it; the other three take `run`.
  return manager === "yarn" ? `yarn ${name}` : `${manager} run ${name}`;
}

/**
 * Name the framework backing a build root, or null when nothing in the registry
 * matches (not a JavaScript app, or a repo with no manifest at all - a Go or
 * Python service builds perfectly well through the same builders, it just has no
 * JS framework to name).
 */
export function detectFramework(
  rootFiles: readonly string[],
  manifest: PackageManifest | null | undefined,
): FrameworkId | null {
  const files = new Set(rootFiles.map((f) => f.toLowerCase()));
  const deps = declaredDependencies(manifest);
  for (const framework of FRAMEWORKS) {
    if (framework.dependencies.some((d) => deps.has(d))) return framework.id;
    if (framework.files.some((f) => files.has(f))) return framework.id;
  }
  return null;
}
