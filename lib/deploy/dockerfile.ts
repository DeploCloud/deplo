import "server-only";

import type { BuildConfig } from "../types/build";

export function generateDockerfile(
  build: BuildConfig,
  envKeys: string[] = [],
): string {
  const node =
    (build.runtimeVersion || "20").replace(/[^\d.]/g, "").split(".")[0] || "20";
  const root = (build.rootDirectory || ".").replace(/^\.?\/?/, "") || ".";
  const workdir = root === "." || root === "" ? "/app" : `/app/${root}`;
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
  for (const key of dockerfileEnvKeys(envKeys)) {
    lines.push(`ARG ${key}`);
    if (SELF_SET_ENV.has(key)) lines.push(`ENV ${key}=$${key}`);
  }

  if (skipInstall) {
    lines.push(`COPY . .`);
    if (buildCmd && !skipBuild) lines.push(`RUN ${buildCmd}`);
  } else if (installOverride) {
    lines.push(`COPY . .`, `RUN ${installOverride}`);
    if (buildCmd && !skipBuild) lines.push(`RUN ${buildCmd}`);
  } else {
    lines.push(`COPY ${MANIFEST_GLOBS} ./`, ...AUTO_INSTALL_RUN);
    lines.push(`COPY . .`);
    if (buildCmd && !skipBuild) lines.push(`RUN ${buildCmd}`);
  }

  lines.push(`EXPOSE ${port}`, `CMD ${toExecForm(start)}`);
  return lines.join("\n") + "\n";
}

const SELF_SET_ENV = new Set(["NODE_ENV"]);

const MANIFEST_GLOBS =
  "package.json package-lock.json* npm-shrinkwrap.json* pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc*";

const AUTO_INSTALL_RUN = [
  `RUN if [ -f pnpm-lock.yaml ] && grep -q '"packageManager"' package.json; then \\`,
  `      corepack enable && pnpm install --frozen-lockfile --prod=false; \\`,
  `    elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \\`,
  `      npm ci --include=dev; \\`,
  `    else \\`,
  `      npm install --include=dev; \\`,
  `    fi`,
];

export function dockerfileEnvKeys(envKeys: string[]): string[] {
  return [
    ...new Set(envKeys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))),
  ].sort();
}

function toExecForm(cmd: string): string {
  return `["sh", "-c", ${JSON.stringify(cmd)}]`;
}
