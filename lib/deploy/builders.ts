import "server-only";

import { mkdir, rm, writeFile, cp, access, realpath } from "node:fs/promises";
import { join, dirname, basename, sep } from "node:path";
import { docker } from "../infra/docker";
import { spawnStream } from "../infra/exec";
import { generateDockerfile } from "./dockerfile";
import { DEFAULT_NODE_MAJOR } from "../frameworks";
import type { BuildConfig, BuildMethod } from "../types";

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";

/** A line sink — the deploy job pipes these into the live build log. */
type Logger = (level: "info" | "command" | "warn" | "error", text: string) => void;

export interface BuildContext {
  /** Full build configuration (method + per-method settings + commands). */
  build: BuildConfig;
  /** Root of the clone (temp dir). Used to guard paths from escaping. */
  workDir: string;
  /** Resolved build directory (clone root or its rootDirectory subdir). */
  buildDir: string;
  slug: string;
  appId: string;
  /** Target image tag the method must produce, e.g. deplo/<slug>:<sha12>. */
  imageRef: string;
  log: Logger;
}

/**
 * Turn a cloned repository into a runnable image tagged `imageRef`, using the
 * project's selected build method. Each method ends with `imageRef` present in
 * the local Docker store carrying the three `deplo.*` labels and listening on
 * `build.port`. Throws on any failure (the caller marks the deploy errored).
 *
 * Every method runs entirely through the `docker` CLI against the mounted
 * daemon socket — the only build tool guaranteed on the host. Methods that
 * `docker build` a context tar-stream it over the socket (no host-visible path
 * needed); methods that bind-mount the clone (Cloud Native Buildpacks, the
 * BuildKit daemon) first stage it onto a host-visible volume.
 */
export async function buildImage(ctx: BuildContext): Promise<void> {
  const method = ctx.build.buildMethod;
  ctx.log("info", `Building with ${methodLabel(method)}`);
  switch (method) {
    case "dockerfile":
      return buildFromDockerfile(ctx);
    case "static":
      return buildStatic(ctx);
    case "nixpacks":
      return buildNixpacks(ctx);
    case "railpack":
      return buildRailpack(ctx);
    default:
      // Unknown/legacy method: fall back to the generated-Dockerfile path so a
      // project created before build methods existed still deploys.
      return buildGenerated(ctx);
  }
}

function methodLabel(m: BuildMethod): string {
  return (
    {
      dockerfile: "Dockerfile",
      railpack: "Railpack",
      nixpacks: "Nixpacks",
      static: "Static (nginx)",
    } as Record<BuildMethod, string>
  )[m];
}

/**
 * Normalise a pinned runtime version to a bare Node MAJOR: "v22.3.0" → "22",
 * "20.x" → "20". Both Nixpacks (`NIXPACKS_NODE_VERSION`) and Railpack
 * (`RAILPACK_NODE_VERSION`) pin the major only, and the generated Dockerfile
 * uses `node:<major>-alpine`. Returns "" when nothing usable is pinned — callers
 * decide the fallback (Nixpacks/Railpack default to {@link DEFAULT_NODE_MAJOR}).
 */
function nodeMajorFrom(runtimeVersion: string | undefined): string {
  const digits = (runtimeVersion || "").replace(/[^\d.]/g, "");
  return digits.split(".")[0] || "";
}

/** The three image labels every method stamps, as repeated `--label` argv. */
function labelArgs(ctx: BuildContext): string[] {
  return [
    "--label",
    "deplo.managed=true",
    "--label",
    `deplo.project=${ctx.appId}`,
    "--label",
    `deplo.slug=${ctx.slug}`,
  ];
}

/** Stream a `docker` invocation into the build log; throw on non-zero exit. */
async function run(
  ctx: BuildContext,
  args: string[],
  timeout: number,
  extraEnv?: Record<string, string>,
): Promise<void> {
  ctx.log("command", `docker ${args.join(" ")}`);
  const code = await spawnStream("docker", args, (l) => ctx.log("info", l), {
    timeout,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (code !== 0) throw new Error(`docker ${args[0]} failed (exit ${code})`);
}

/**
 * Resolve a user-supplied repo-relative path (a Dockerfile or build context)
 * against buildDir, normalised and re-checked so it cannot escape the work
 * dir. Containment is verified with realpath on the parent directory — string
 * prefix checks alone are bypassable by a symlinked path component (an uploaded
 * archive is attacker-controlled), and the target file may not exist yet, so we
 * canonicalise the parent (which must exist) and re-append the basename.
 * Returns buildDir itself on `.`/empty or any escape.
 */
async function resolveInside(
  ctx: BuildContext,
  rel: string | undefined,
): Promise<string> {
  const norm = (rel || ".").replace(/\\/g, "/").replace(/^\.?\/?/, "");
  if (!norm || norm === ".") return ctx.buildDir;
  if (norm.split("/").includes("..")) return ctx.buildDir;
  const abs = join(ctx.buildDir, norm);
  try {
    const realWork = await realpath(ctx.workDir);
    const realParent = await realpath(dirname(abs));
    const contained =
      realParent === realWork || realParent.startsWith(realWork + sep);
    return contained ? join(realParent, basename(abs)) : ctx.buildDir;
  } catch {
    return ctx.buildDir;
  }
}

// ---------------------------------------------------------------------------
// dockerfile
// ---------------------------------------------------------------------------

async function buildFromDockerfile(ctx: BuildContext): Promise<void> {
  const s = ctx.build.methodSettings;
  const dockerfile = await resolveInside(ctx, s.dockerfilePath || "Dockerfile");
  const contextDir = await resolveInside(ctx, s.dockerContextPath || ".");
  const stage = (s.dockerBuildStage || "").trim();

  try {
    await access(dockerfile);
  } catch {
    throw new Error(
      `No Dockerfile at "${s.dockerfilePath || "Dockerfile"}". The Dockerfile build method requires one in the repository.`,
    );
  }

  await run(
    ctx,
    [
      "build",
      "-f",
      dockerfile,
      ...(stage ? ["--target", stage] : []),
      "-t",
      ctx.imageRef,
      ...labelArgs(ctx),
      contextDir,
    ],
    900_000,
  );
}

/** Legacy/auto path: generate a Node Dockerfile from build settings and build. */
async function buildGenerated(ctx: BuildContext): Promise<void> {
  const dfPath = join(ctx.buildDir, "Dockerfile");
  try {
    await access(dfPath);
  } catch {
    ctx.log("info", "No Dockerfile found — generating one from build settings");
    await writeFile(dfPath, generateDockerfile(ctx.build));
  }
  await run(
    ctx,
    ["build", "-t", ctx.imageRef, ...labelArgs(ctx), ctx.buildDir],
    900_000,
  );
}

// ---------------------------------------------------------------------------
// static (nginx)
// ---------------------------------------------------------------------------

async function buildStatic(ctx: BuildContext): Promise<void> {
  const { build } = ctx;
  const port = build.port || 80;
  const outputDir = (build.outputDirectory || ".").replace(/^\.?\/?/, "") || ".";
  const spa = build.methodSettings.staticSinglePageApp ?? false;
  const tryFiles = spa ? "try_files $uri /index.html;" : "try_files $uri $uri/ =404;";

  const nginxConf = `server {
  listen       ${port};
  server_name  _;
  root   /usr/share/nginx/html;
  index  index.html;
  gzip on;
  gzip_types text/plain text/css application/javascript application/json image/svg+xml;
  location / {
    ${tryFiles}
  }
}
`;
  await writeFile(join(ctx.buildDir, "deplo-nginx.conf"), nginxConf);

  const buildCmd = (build.buildCommand || "").trim();
  let dockerfile: string;
  if (buildCmd) {
    // Two-stage: run install + build, then serve the output with nginx. The
    // builder stage is Node-based; honour a pinned runtimeVersion, else default.
    const node = (build.runtimeVersion || "20").replace(/[^\d.]/g, "").split(".")[0] || "20";
    const install = (build.installCommand || "npm ci").trim();
    dockerfile = `FROM node:${node}-alpine AS builder
WORKDIR /app
COPY . .
RUN ${install}
RUN ${buildCmd}
FROM nginx:alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY deplo-nginx.conf /etc/nginx/conf.d/deplo.conf
COPY --from=builder /app/${outputDir}/ /usr/share/nginx/html/
EXPOSE ${port}
CMD ["nginx", "-g", "daemon off;"]
`;
  } else {
    // Already-static: copy the output dir straight into nginx.
    dockerfile = `FROM nginx:alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY deplo-nginx.conf /etc/nginx/conf.d/deplo.conf
COPY ${outputDir}/ /usr/share/nginx/html/
EXPOSE ${port}
CMD ["nginx", "-g", "daemon off;"]
`;
  }
  await writeFile(join(ctx.buildDir, "Dockerfile"), dockerfile);

  await run(
    ctx,
    ["build", "-t", ctx.imageRef, ...labelArgs(ctx), ctx.buildDir],
    900_000,
  );
}

// ---------------------------------------------------------------------------
// nixpacks — host binary generates a Dockerfile, then docker build (tar-stream)
// ---------------------------------------------------------------------------

async function buildNixpacks(ctx: BuildContext): Promise<void> {
  const { build } = ctx;
  // Phase 1: generate .nixpacks/Dockerfile WITHOUT the daemon (host binary).
  const prepArgs = ["build", ctx.buildDir, "--out", ctx.buildDir, "--no-error-without-start"];
  prepArgs.push("--env", `PORT=${build.port}`);
  // Pin the Node major: the user's pin when set, else DEFAULT_NODE_MAJOR so a
  // current Node is used instead of nixpacks' stale built-in default (it picks
  // nodejs_18). nixpacks reads NIXPACKS_NODE_VERSION (major only) and it takes
  // precedence over package.json engines / .nvmrc; it's ignored for non-Node repos.
  const nodeMajor = nodeMajorFrom(build.runtimeVersion) || DEFAULT_NODE_MAJOR;
  prepArgs.push("--env", `NIXPACKS_NODE_VERSION=${nodeMajor}`);
  if (build.installCommand?.trim()) prepArgs.push("-i", build.installCommand.trim());
  if (build.buildCommand?.trim()) prepArgs.push("-b", build.buildCommand.trim());
  if (build.startCommand?.trim()) prepArgs.push("-s", build.startCommand.trim());

  ctx.log("command", `nixpacks ${prepArgs.join(" ")}`);
  const code = await spawnStream("nixpacks", prepArgs, (l) => ctx.log("info", l), {
    timeout: 300_000,
  });
  if (code !== 0) {
    throw new Error(
      `nixpacks failed (exit ${code}). Ensure the nixpacks binary is installed on the host.`,
    );
  }

  const generated = join(ctx.buildDir, ".nixpacks", "Dockerfile");
  const publishDir = build.methodSettings.nixpacksPublishDirectory?.trim();

  if (!publishDir) {
    // App with a start command: build the generated Dockerfile directly.
    await run(
      ctx,
      [
        "build",
        "-f",
        generated,
        "-t",
        ctx.imageRef,
        "--build-arg",
        `PORT=${build.port}`,
        ...labelArgs(ctx),
        ctx.buildDir,
      ],
      900_000,
      { DOCKER_BUILDKIT: "1" },
    );
    return;
  }

  // Static publish dir: build a staging image, then nginx-wrap its output.
  const staging = `deplo-nixpacks-staging:${ctx.imageRef.split(":").pop()}`;
  await run(
    ctx,
    ["build", "-f", generated, "-t", staging, "--build-arg", `PORT=${build.port}`, ctx.buildDir],
    900_000,
    { DOCKER_BUILDKIT: "1" },
  );
  try {
    // Strip only a leading "./" (or a stray leading "/"); do NOT eat a bare
    // leading "." — that is part of dot-dir names like ".next"/".output".
    await nginxWrap(ctx, staging, `/app/${publishDir.replace(/^(?:\.\/|\/)/, "")}`);
  } finally {
    await docker(["rmi", staging], { timeout: 30_000 }).catch(() => {});
  }
}

/**
 * Build an nginx image that serves files copied out of `fromImage` at
 * `srcPath`, listening on build.port. Used by the nixpacks static path.
 */
async function nginxWrap(
  ctx: BuildContext,
  fromImage: string,
  srcPath: string,
): Promise<void> {
  const port = ctx.build.port || 80;
  const spa = ctx.build.methodSettings.staticSinglePageApp ?? false;
  const tryFiles = spa ? "try_files $uri /index.html;" : "try_files $uri $uri/ =404;";
  const conf = `server {
  listen ${port};
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  location / { ${tryFiles} }
}
`;
  await writeFile(join(ctx.buildDir, "deplo-nginx.conf"), conf);
  const wrapper = `FROM ${fromImage} AS built
FROM nginx:alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY deplo-nginx.conf /etc/nginx/conf.d/deplo.conf
COPY --from=built ${srcPath}/ /usr/share/nginx/html/
EXPOSE ${port}
CMD ["nginx", "-g", "daemon off;"]
`;
  const wrapperPath = join(ctx.buildDir, "deplo-static.Dockerfile");
  await writeFile(wrapperPath, wrapper);
  await run(
    ctx,
    ["build", "-f", wrapperPath, "-t", ctx.imageRef, ...labelArgs(ctx), ctx.buildDir],
    600_000,
  );
}

// ---------------------------------------------------------------------------
// railpack — privileged buildkitd container + buildctl + tar load + relabel
// ---------------------------------------------------------------------------

async function buildRailpack(ctx: BuildContext): Promise<void> {
  const ver = (ctx.build.methodSettings.railpackVersion || "latest").trim();
  // The configured version feeds two consumers with different tag grammars:
  //   - the railpack-frontend image, whose registry tags are `latest` or
  //     `v0.27.2` (a leading `v` on concrete versions);
  //   - install.sh's RAILPACK_VERSION, which wants a BARE version (`0.27.2`,
  //     it re-adds the `v`) and has no "latest" sentinel — passing the literal
  //     "latest" yields a `vlatest` download URL that 404s. The script only
  //     auto-resolves the newest release when the var is unset/empty.
  // So: pin → normalise to the grammar each side expects; latest → frontend
  // uses the `latest` tag, install.sh gets no RAILPACK_VERSION at all.
  // Bare, `v`-less form (`0.27.2`) the install script wants; null = "latest".
  const pinned =
    ver === "" || ver.toLowerCase() === "latest"
      ? null
      : ver.replace(/^v/i, "");
  const frontendTag = pinned ? `v${pinned}` : "latest";
  const frontend = `ghcr.io/railwayapp/railpack-frontend:${frontendTag}`;
  const { hostPath, cleanup, dir, toHostPath } = await stageOnHostVolume(ctx);
  const planDir = join(dir, "..", `${ctx.slug}-plan`);
  const planHost = toHostPath(planDir);
  await mkdir(planDir, { recursive: true });
  const buildkitd = `deplo-buildkitd-${ctx.slug}`;
  const tarPath = join(dir, "..", `${ctx.slug}.tar`);

  // Node version + build/start overrides ride into the plan through the
  // container ENVIRONMENT (docker `-e KEY=VALUE`, an argv — so a user-supplied
  // command can never break out of the `bash -lc` string), then railpack reads
  // each with a BARE `--env KEY` (it does os.LookupEnv on bare keys). Bare refs
  // for an unset key are harmless no-ops, so they stay constant in the command.
  const railEnv: string[] = [];
  // Node major: the user's pin when set, else DEFAULT_NODE_MAJOR so a current
  // Node is used instead of railpack's built-in default. Provider-scoped, so a
  // non-Node repo built via railpack is unaffected.
  const nodeMajor = nodeMajorFrom(ctx.build.runtimeVersion) || DEFAULT_NODE_MAJOR;
  railEnv.push("-e", `RAILPACK_NODE_VERSION=${nodeMajor}`);
  const railBuildCmd = (ctx.build.buildCommand || "").trim();
  if (railBuildCmd) railEnv.push("-e", `RAILPACK_BUILD_CMD=${railBuildCmd}`);
  const railStartCmd = (ctx.build.startCommand || "").trim();
  if (railStartCmd) railEnv.push("-e", `RAILPACK_START_CMD=${railStartCmd}`);

  try {
    // Phase A: generate the railpack plan (daemon-free, glibc base).
    await run(
      ctx,
      [
        "run",
        "--rm",
        "-v",
        `${hostPath}:/app:ro`,
        "-v",
        `${planHost}:/out`,
        "-w",
        "/app",
        // Pin the CLI only when the user pinned a version; otherwise let
        // install.sh resolve the latest release from GitHub itself.
        ...(pinned ? ["-e", `RAILPACK_VERSION=${pinned}`] : []),
        ...railEnv,
        "debian:bookworm-slim",
        "bash",
        "-lc",
        "apt-get update -qq && apt-get install -y -qq curl ca-certificates tar && curl -sSL https://railpack.com/install.sh | bash && railpack prepare /app --env RAILPACK_NODE_VERSION --env RAILPACK_BUILD_CMD --env RAILPACK_START_CMD --plan-out /out/railpack-plan.json --info-out /out/railpack-info.json",
      ],
      600_000,
    );

    // Phase B: a privileged buildkitd with context+plan mounted, build via buildctl.
    await docker(["rm", "-f", buildkitd], { timeout: 15_000 }).catch(() => {});
    await run(
      ctx,
      [
        "run",
        "-d",
        "--name",
        buildkitd,
        "--privileged",
        "-v",
        `${hostPath}:/context:ro`,
        "-v",
        `${planHost}:/plan:ro`,
        "moby/buildkit:v0.16.0",
      ],
      60_000,
    );

    ctx.log("command", `buildctl build (railpack frontend ${frontendTag})`);
    const code = await spawnStream(
      "sh",
      [
        "-c",
        `docker exec ${buildkitd} buildctl build --frontend=gateway.v0 --opt source=${frontend} --local context=/context --local dockerfile=/plan --opt filename=railpack-plan.json --output type=docker,name=${ctx.imageRef} > ${tarPath}`,
      ],
      (l) => ctx.log("info", l),
      { timeout: 1_200_000 },
    );
    if (code !== 0) throw new Error(`railpack buildctl failed (exit ${code})`);

    await run(ctx, ["load", "-i", tarPath], 300_000);
    // railpack frontend output carries no labels — re-stamp ours.
    await relabel(ctx);
  } finally {
    await docker(["rm", "-f", buildkitd], { timeout: 30_000 }).catch(() => {});
    await rm(tarPath, { force: true }).catch(() => {});
    await rm(planDir, { recursive: true, force: true }).catch(() => {});
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// shared helpers for bind-mount-based builders
// ---------------------------------------------------------------------------

/**
 * Copy the build dir onto the data volume and return the HOST-side path the
 * daemon can bind-mount. The deplo app's clone lives in its own container's
 * /tmp, which the host daemon cannot see; staging onto `DEPLO_DATA_DIR` (the
 * shared `deplo-data` volume) gives a path resolvable through the volume's
 * host mountpoint, discovered by inspecting deplo's own container mounts.
 */
interface HostStage {
  /** Container-side path of the staged copy (what the deplo process writes). */
  dir: string;
  /** Host-side path of `dir`, what `docker run -v` must reference. */
  hostPath: string;
  /** Translate any container path under DATA_DIR to its host equivalent. */
  toHostPath: (containerPath: string) => string;
  cleanup: () => Promise<void>;
}

async function stageOnHostVolume(ctx: BuildContext): Promise<HostStage> {
  const stagingRoot = join(DATA_DIR, "builds");
  const sub = `${ctx.slug}-${ctx.imageRef.split(":").pop()}`;
  const dir = join(stagingRoot, sub); // container-side path
  await mkdir(dir, { recursive: true });
  await cp(ctx.buildDir, dir, { recursive: true });

  const mountpoint = await dataVolumeHostMountpoint();
  if (!mountpoint) {
    ctx.log(
      "warn",
      "Could not resolve the data volume's host path; bind mount may fail. " +
        "Ensure DEPLO_DATA_DIR is a host-visible volume.",
    );
  }
  // A container path under DATA_DIR maps to the same relative path under the
  // volume's host mountpoint; outside DATA_DIR we can only pass it through.
  const toHostPath = (p: string): string =>
    mountpoint && p.startsWith(DATA_DIR)
      ? join(mountpoint, p.slice(DATA_DIR.length))
      : p;

  return {
    dir,
    hostPath: toHostPath(dir),
    toHostPath,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

/**
 * Find the host filesystem path backing DEPLO_DATA_DIR by inspecting the deplo
 * container's own mounts (Coolify uses the same trick). Returns "" if it can't
 * be determined (e.g. running outside a container).
 */
let cachedMountpoint: string | null | undefined;
export async function dataVolumeHostMountpoint(): Promise<string> {
  if (cachedMountpoint !== undefined) return cachedMountpoint ?? "";
  try {
    const { hostname } = await import("node:os");
    const self = hostname(); // container id by default
    const { stdout } = await docker(
      ["inspect", "-f", "{{json .Mounts}}", self],
      { timeout: 10_000 },
    );
    const mounts = JSON.parse(stdout) as {
      Destination: string;
      Source: string;
    }[];
    // The mount whose Destination is DATA_DIR (or a parent of it).
    const match = mounts
      .filter((m) => DATA_DIR === m.Destination || DATA_DIR.startsWith(m.Destination + "/"))
      .sort((a, b) => b.Destination.length - a.Destination.length)[0];
    cachedMountpoint = match?.Source ?? null;
  } catch {
    cachedMountpoint = null;
  }
  return cachedMountpoint ?? "";
}

/**
 * Re-stamp the three deplo labels onto an already-built image via a
 * metadata-only `docker build`. Used after builders (pack, railpack) that
 * don't apply our labels themselves.
 */
async function relabel(ctx: BuildContext): Promise<void> {
  const dockerfile = `FROM ${ctx.imageRef}\nLABEL deplo.managed=true deplo.project=${ctx.appId} deplo.slug=${ctx.slug}\n`;
  ctx.log("command", `docker build (relabel ${ctx.imageRef})`);
  // A `FROM`+`LABEL` Dockerfile needs no context files, so feed it as the whole
  // build context via stdin (`docker build -`). Two pitfalls this avoids:
  // passing a `/dev/null` context path fails under BuildKit ("unable to prepare
  // context: path /dev/null not found"); and routing through `printf '%s'` in a
  // shell emits the `\n`s literally, so BuildKit parses one giant FROM line
  // ("FROM requires either one or three arguments"). Piping real bytes to
  // `docker`'s own stdin sidesteps both.
  const code = await spawnStream(
    "docker",
    ["build", "-t", ctx.imageRef, "-"],
    (l) => ctx.log("info", l),
    { timeout: 60_000, input: dockerfile },
  );
  if (code !== 0) throw new Error(`relabel build failed (exit ${code})`);
}
