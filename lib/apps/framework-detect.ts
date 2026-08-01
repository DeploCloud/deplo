/**
 * Pure framework recognition: given the files at an app's build root and its
 * parsed `package.json`, name the framework from the
 * {@link file://./framework-catalog.ts} registry.
 *
 * Everything here is a total function over data — no I/O, no fetch, no fs — so
 * the server arms ({@link file://./framework-source.ts}) differ only in how they
 * obtain the two inputs, and the whole rule set is testable without a repo, a
 * network or a database. Same split as favicon detection (`favicon-shared` ranks,
 * `favicon-detect` reads).
 */
import {
  FRAMEWORKS,
  type FrameworkId,
} from "./framework-catalog";

/** The `package.json` fields recognition reads. Everything is optional — the
 * file is arbitrary user JSON, not a contract. */
export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Parse a `package.json` payload, or null when it is not a JSON object. Note
 * `JSON.parse("null")` and `JSON.parse("[]")` both succeed, so the shape is
 * checked rather than assumed — a repo can ship anything under that name.
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
 * The DIRECT dependency names declared by a manifest — `dependencies` plus
 * `devDependencies`, which is where a framework always sits (Vite, Astro and
 * SvelteKit live in devDependencies; Next and Express in dependencies).
 * Transitive packages are deliberately invisible: an app that merely pulls
 * `express` in through something else is not an Express app.
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
 * relative path list (a recursive git tree, a directory walk). `rootRel` is the
 * app's rootDirectory in normalised form ("" or "." for the repo root) — in a
 * monorepo the framework is whatever lives in the sub-app being built, not
 * whatever the top of the repo happens to contain.
 *
 * Only the immediate children survive: a `next.config.js` three directories down
 * says nothing about the app Deplo is deploying. Returned lowercase, matching how
 * the catalog spells its markers.
 */
export function rootFileNames(
  paths: readonly string[],
  rootRel = "",
): string[] {
  const prefix = rootRel && rootRel !== "." ? `${rootRel.replace(/\/+$/, "")}/` : "";
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

/**
 * Name the framework backing a build root, or null when nothing in the registry
 * matches (not a JavaScript app, or a repo with no manifest at all — a Go or
 * Python service builds perfectly well through the same builders, it just has no
 * JS framework to name).
 *
 * A framework matches on EITHER signal — a declared dependency or a config file
 * at the root — because each one alone is conclusive in practice and neither is
 * always present (`sveltekit` ships no distinctive file; a bare `astro.config.mjs`
 * is unmistakable). The first match in {@link FRAMEWORKS} order wins, which is
 * what keeps a Next.js app from being reported as React.
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
