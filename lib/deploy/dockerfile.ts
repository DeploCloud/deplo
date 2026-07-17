import "server-only";

import type { BuildConfig } from "../types";

/**
 * Generate a Dockerfile from a project's build settings when the repository
 * does not ship one. Node-oriented (the common fallback case); apps in
 * other languages should provide their own Dockerfile.
 *
 * `envKeys` are the names of the env vars the deploy resolved for this app —
 * each is declared `ARG KEY` + `ENV KEY=$KEY` so the install/build commands
 * see it (build-time-inlined config like Next.js NEXT_PUBLIC_* only works if
 * the var exists while `next build` runs). Only the NAMES are rendered here;
 * the agent supplies the values at `docker build` time as bare `--build-arg
 * KEY` flags resolved from its process env, so no value is ever baked into
 * the Dockerfile text that crosses the wire and lands on disk.
 *
 * Layer-cache discipline (the reason builds aren't a cold `npm install` every
 * push): on the DEFAULT path we copy only the dependency manifests, install,
 * and THEN copy the source — so a code-only change reuses the cached install
 * layer instead of reinstalling from scratch. A user-supplied installCommand
 * keeps the old copy-everything-first order, because a custom install may read
 * source files that a manifest-only context wouldn't have.
 *
 * Dev-dependency discipline: `ENV NODE_ENV=production` makes every package
 * manager (npm, pnpm, yarn) drop devDependencies — which silently starves the
 * BUILD step of its tooling (tsc, bundlers, …). The generated install therefore
 * forces devDependencies in (`--include=dev` / `--prod=false`) so `next build`
 * & friends have what they need, while the image still RUNS as production.
 */
export function generateDockerfile(build: BuildConfig, envKeys: string[] = []): string {
  // This generated path is Node-only; honour a pinned runtimeVersion, else default.
  const node = (build.runtimeVersion || "20").replace(/[^\d.]/g, "").split(".")[0] || "20";
  const root = (build.rootDirectory || ".").replace(/^\.?\/?/, "") || ".";
  const workdir = root === "." || root === "" ? "/app" : `/app/${root}`;
  const installOverride = build.installCommand?.trim();
  const buildCmd = build.buildCommand?.trim();
  const start = build.startCommand?.trim() || "node server.js";
  const port = build.port || 3000;

  const lines = [
    `FROM node:${node}-alpine`,
    `WORKDIR ${workdir}`,
    `ENV NODE_ENV=production`,
  ];
  // One ARG/ENV pair per line (classic-builder compatible), sorted for a
  // deterministic file (and therefore deterministic docker layer caching).
  // A user-supplied NODE_ENV intentionally lands AFTER the default above, so
  // it wins — mirroring the runtime fold, where the user's env beats defaults.
  // These sit BEFORE the install so install/build both see the vars; they are
  // stable across code-only pushes, so they don't disturb the install cache.
  for (const key of dockerfileEnvKeys(envKeys)) {
    lines.push(`ARG ${key}`, `ENV ${key}=$${key}`);
  }

  if (installOverride) {
    // Custom install: it may reference source files, so keep the whole tree
    // available (copy-everything-first, as before). No cache-splitting and no
    // dev-dep forcing — the user owns this command verbatim.
    lines.push(`COPY . .`, `RUN ${installOverride}`);
    if (buildCmd) lines.push(`RUN ${buildCmd}`);
  } else {
    // Default path: manifests → install (cached across code changes) → source →
    // build. Only the dependency descriptors are copied before the install so
    // the install layer's cache key is the lockfile, not the whole repo.
    lines.push(`COPY ${MANIFEST_GLOBS} ./`, ...AUTO_INSTALL_RUN);
    lines.push(`COPY . .`);
    if (buildCmd) lines.push(`RUN ${buildCmd}`);
  }

  lines.push(`EXPOSE ${port}`, `CMD ${toExecForm(start)}`);
  return lines.join("\n") + "\n";
}

/**
 * The dependency descriptors copied before the install so the install layer
 * caches on the lockfile rather than the whole source tree. `package.json` is a
 * literal (a Node app always has it — its absence fails the build early and
 * clearly); the rest are wildcards, so a missing lockfile is skipped rather than
 * erroring. `.npmrc` and `pnpm-workspace.yaml` ride along because they change how
 * the install resolves.
 */
const MANIFEST_GLOBS =
  "package.json package-lock.json* npm-shrinkwrap.json* pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc*";

/**
 * The default install step: pick the package manager from the lockfile and force
 * devDependencies in (they hold the build tooling; see the dev-dep note above).
 *
 * - pnpm is used ONLY when the repo pins `packageManager` in package.json, so
 *   Corepack resolves a version compatible with the base Node — an unpinned repo
 *   would otherwise pull the latest pnpm, which can refuse to run on `node:20`.
 *   Everything else (yarn included — its Plug'n'Play default produces no
 *   node_modules a generic image can run) resolves through npm off package.json,
 *   which is exactly the prior behaviour, now cached and with devDependencies.
 * - `npm ci` when a lockfile is present (deterministic + faster), else
 *   `npm install`.
 *
 * Emitted as one multi-line `RUN` (each element is a line of the file).
 */
const AUTO_INSTALL_RUN = [
  `RUN if [ -f pnpm-lock.yaml ] && grep -q '"packageManager"' package.json; then \\`,
  `      corepack enable && pnpm install --frozen-lockfile --prod=false; \\`,
  `    elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \\`,
  `      npm ci --include=dev; \\`,
  `    else \\`,
  `      npm install --include=dev; \\`,
  `    fi`,
];

/**
 * The env-key names safe to declare in a generated Dockerfile: identifier-shaped
 * only (a legitimate env var name always is; anything else must not reach
 * Dockerfile syntax), deduped and sorted. Exported for the deploy-request seam.
 */
export function dockerfileEnvKeys(envKeys: string[]): string[] {
  return [...new Set(envKeys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)))].sort();
}

/** Render a shell command as a Dockerfile CMD exec array. */
function toExecForm(cmd: string): string {
  return `["sh", "-c", ${JSON.stringify(cmd)}]`;
}
