import { FRAMEWORKS, type FrameworkId } from "./framework-catalog";

// PackageManifest - the `package.json` fields recognition reads; all optional, it is arbitrary user JSON.
export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

// parsePackageManifest - null unless the payload is a JSON object; `null` and `[]` also parse, so the shape is checked.
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

// declaredDependencies - the direct names from `dependencies` plus `devDependencies`, where a framework always sits.
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

// rootFileNames - the file names sitting directly in the build root, from a repo-root relative path list.
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

// PackageManager - the package managers a lockfile at the build root can name.
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

// Most specific first, the same priority the generated Dockerfile's install step uses.
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

// packageManagerFrom - the manager named by the lockfile, npm when nothing says otherwise.
export function packageManagerFrom(
  rootFiles: readonly string[],
): PackageManager {
  const files = new Set(rootFiles.map((f) => f.toLowerCase()));
  for (const [file, manager] of LOCKFILES) if (files.has(file)) return manager;
  return "npm";
}

// DetectedCommands - the commands a repository declares for itself, null where it declares none.
export interface DetectedCommands {
  buildCommand: string | null;
}

const NO_COMMANDS: DetectedCommands = { buildCommand: null };

// detectCommands - the build command a repo declares in its own `package.json`, never one invented from the framework.
// No start command on purpose: a repo's `start` is as often the dev server as the production one.
export function detectCommands(
  rootFiles: readonly string[],
  manifest: PackageManifest | null | undefined,
): DetectedCommands {
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return NO_COMMANDS;
  }
  return {
    buildCommand: runScript(packageManagerFrom(rootFiles), scripts, "build"),
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

// frameworkDefaults - what a framework needs that no builder supplies, when the answer lives in its dependencies.
export function frameworkDefaults(
  framework: FrameworkId | null,
  deps: ReadonlySet<string>,
): { staticOutput: string | null; startCommand: string | null } {
  // A SvelteKit build is whatever its adapter emits, and a builder only handles adapter-auto.
  if (framework === "sveltekit") {
    if (deps.has("@sveltejs/adapter-static"))
      return { staticOutput: "build", startCommand: null };
    if (deps.has("@sveltejs/adapter-node"))
      return { staticOutput: null, startCommand: "node build" };
  }
  // `node ace build` emits a whole app under build/, so the repo's own entry only runs from inside it.
  if (framework === "adonisjs")
    return { staticOutput: null, startCommand: "node build/bin/server.js" };
  return { staticOutput: null, startCommand: null };
}

// angularOutputDir - read from `angular.json`, because the path carries the project's own name.
export function angularOutputDir(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const root = parsed as {
    defaultProject?: string;
    projects?: Record<string, unknown>;
  } | null;
  const projects = root?.projects;
  if (!projects || typeof projects !== "object") return null;

  const names = Object.keys(projects);
  const name = root?.defaultProject
    ? names.find((n) => n === root.defaultProject)
    : names[0];
  if (!name) return null;

  const project = projects[name] as {
    architect?: Record<string, BuildTarget>;
    targets?: Record<string, BuildTarget>;
  };
  // `architect` is the pre-17 spelling of `targets`; both still ship.
  const build = project?.targets?.build ?? project?.architect?.build;
  if (!build) return null;

  const options = build.options ?? {};
  const outputPath =
    typeof options.outputPath === "string"
      ? options.outputPath
      : typeof options.outputPath?.base === "string"
        ? options.outputPath.base
        : `dist/${name}`;
  // The application builder splits its output into browser/ and server/.
  const application =
    typeof build.builder === "string" && build.builder.endsWith(":application");
  const dir = application ? `${outputPath}/browser` : outputPath;
  return /^[\w.][\w./-]*$/.test(dir) && !dir.includes("..") ? dir : null;
}

interface BuildTarget {
  builder?: string;
  options?: { outputPath?: string | { base?: string }; browser?: string };
}

// detectFramework - the framework backing a build root, or null when nothing in the registry matches.
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
