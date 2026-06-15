import "server-only";

import type { BuildConfig } from "../types";

/**
 * Generate a Dockerfile from a project's build settings when the repository
 * does not ship one. Node-oriented (the common case for the supported
 * frameworks); projects in other languages should provide their own Dockerfile.
 */
export function generateDockerfile(build: BuildConfig): string {
  const node = (build.nodeVersion || "20").replace(/[^\d.]/g, "").split(".")[0] || "20";
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
    `COPY . .`,
    `RUN ${install}`,
  ];
  if (buildCmd) lines.push(`RUN ${buildCmd}`);
  lines.push(`EXPOSE ${port}`, `CMD ${toExecForm(start)}`);
  return lines.join("\n") + "\n";
}

/** Render a shell command as a Dockerfile CMD exec array. */
function toExecForm(cmd: string): string {
  return `["sh", "-c", ${JSON.stringify(cmd)}]`;
}
