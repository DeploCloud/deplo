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
 */
export function generateDockerfile(build: BuildConfig, envKeys: string[] = []): string {
  // This generated path is Node-only; honour a pinned runtimeVersion, else default.
  const node = (build.runtimeVersion || "20").replace(/[^\d.]/g, "").split(".")[0] || "20";
  const root = (build.rootDirectory || ".").replace(/^\.?\/?/, "") || ".";
  const workdir = root === "." || root === "" ? "/app" : `/app/${root}`;
  const install = build.installCommand?.trim() || "npm install";
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
  for (const key of dockerfileEnvKeys(envKeys)) {
    lines.push(`ARG ${key}`, `ENV ${key}=$${key}`);
  }
  lines.push(`COPY . .`, `RUN ${install}`);
  if (buildCmd) lines.push(`RUN ${buildCmd}`);
  lines.push(`EXPOSE ${port}`, `CMD ${toExecForm(start)}`);
  return lines.join("\n") + "\n";
}

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
