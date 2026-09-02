import "server-only";

// https://deplo.build/docs/guides/releases/build-settings

import type { BuildConfig } from "../types";

/**
 * Generate a Dockerfile from a project's build settings when the repository does
 * not ship one.
 */
export function generateDockerfile(
  build: BuildConfig,
  envKeys: string[] = [],
): string {
  // This generated path is Node-only; honour a pinned runtimeVersion, else default.
  const node =
    (build.runtimeVersion || "20").replace(/[^\d.]/g, "").split(".")[0] || "20";
  const root = (build.rootDirectory || ".").replace(/^\.?\/?/, "") || ".";
  const workdir = root === "." || root === "" ? "/app" : `/app/${root}`;
  // NULL is "work it out", an EMPTY STRING is "run nothing here" (migration 0147).
  // A container has to start something, so an empty start command is the former.
  const skipInstall = build.installCommand === "";
  const skipBuild = build.buildCommand === "";
  const installOverride = build.installCommand?.trim();
  const buildCmd = build.buildCommand?.trim();
  const start = build.startCommand?.trim() || "node server.js";
  const port = build.port || 3000;

  const lines = [
    `FROM node:${node}-alpine`,
    `WORKDIR ${workdir}`,
    `ENV NODE_ENV=production`,
  ];
  // One `ARG` per line (classic-builder compatible), sorted for a deterministic file
  // (and therefore deterministic docker layer caching). No matching `ENV`: a build arg
  // already reaches every RUN, so the ENV would only persist the value in the image
  // config. The exception is a name this file sets itself, because an ENV outranks a
  // build arg of the same name and would shadow the user's value for the whole build.
  for (const key of dockerfileEnvKeys(envKeys)) {
    lines.push(`ARG ${key}`);
    if (SELF_SET_ENV.has(key)) lines.push(`ENV ${key}=$${key}`);
  }

  if (skipInstall) {
    // Asked for no install at all: the image is whatever the repo already holds.
    lines.push(`COPY . .`);
    if (buildCmd && !skipBuild) lines.push(`RUN ${buildCmd}`);
  } else if (installOverride) {
    // Custom install: it may reference source files, so keep the whole tree
    // available (copy-everything-first, as before). No cache-splitting and no
    // dev-dep forcing - the user owns this command verbatim.
    lines.push(`COPY . .`, `RUN ${installOverride}`);
    if (buildCmd && !skipBuild) lines.push(`RUN ${buildCmd}`);
  } else {
    // Default path: manifests → install (cached across code changes) → source →
    // build. Only the dependency descriptors are copied before the install so
    // the install layer's cache key is the lockfile, not the whole repo.
    lines.push(`COPY ${MANIFEST_GLOBS} ./`, ...AUTO_INSTALL_RUN);
    lines.push(`COPY . .`);
    if (buildCmd && !skipBuild) lines.push(`RUN ${buildCmd}`);
  }

  lines.push(`EXPOSE ${port}`, `CMD ${toExecForm(start)}`);
  return lines.join("\n") + "\n";
}

/** The env names this file declares as `ENV` itself, so a user var of that name
 * has to be re-declared to win. */
const SELF_SET_ENV = new Set(["NODE_ENV"]);

/**
 * The dependency descriptors copied before the install so the install layer caches
 * on the lockfile rather than the whole source tree. `.npmrc` and
 * `pnpm-workspace.yaml` ride along because they change how the install resolves.
 */
const MANIFEST_GLOBS =
  "package.json package-lock.json* npm-shrinkwrap.json* pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc*";

/**
 * The default install step: pick the package manager from the lockfile and force
 * devDependencies in (they hold the build tooling; see the dev-dep note above).
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
  return [
    ...new Set(envKeys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))),
  ].sort();
}

/** Render a shell command as a Dockerfile CMD exec array. */
function toExecForm(cmd: string): string {
  return `["sh", "-c", ${JSON.stringify(cmd)}]`;
}
