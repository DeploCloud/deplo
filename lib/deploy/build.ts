import "server-only";

import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  access,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import yaml from "js-yaml";
import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { decryptSecret } from "../crypto";
import { recordActivity } from "../data/activity";
import { docker, ensureNetwork } from "../infra/docker";
import { spawnStream } from "../infra/exec";
import { cloneStream, revParse } from "../infra/git";
import { buildImage } from "./builders";
import { extractArchive, safeBuildDir } from "./upload";
import { normalizeBuildConfig } from "../frameworks";
import { usesComposeStack } from "../utils";
import { certResolver, previewDomain, resolveServerIp } from "./domains";
import { buildComposeStack } from "./compose-stack";
import { copyWorkspaceForBuild } from "./dev";
import {
  ensureAutoDomain,
  ensureExtraDomain,
  routableRoutes,
  type RoutableDomain,
} from "../data/domains";
import { installationCloneUrl } from "../github/app";
import type { Deployment, DeploymentEnvironment, LogLine } from "../types";

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const STACK_DIR = join(DATA_DIR, "stacks");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(depId: string, level: LogLine["level"], text: string): void {
  mutate((d) => {
    (d.logs[depId] ??= []).push({ ts: nowIso(), level, text });
  });
}

function setDep(depId: string, patch: Partial<Deployment>): void {
  mutate((d) => {
    const x = d.deployments.find((y) => y.id === depId);
    if (x) Object.assign(x, patch);
  });
}

function setProject(projectId: string, patch: Record<string, unknown>): void {
  mutate((d) => {
    const p = d.projects.find((x) => x.id === projectId);
    if (p) Object.assign(p, patch, { updatedAt: nowIso() });
  });
}

/** Decrypted env (project vars targeting production + attached shared groups). */
function projectEnv(projectId: string): Record<string, string> {
  const d = read();
  const out: Record<string, string> = {};
  for (const e of d.envVars) {
    if (e.projectId === projectId && e.targets.includes("production")) {
      out[e.key] = decryptSecret(e.valueEnc);
    }
  }
  for (const g of d.sharedEnvGroups ?? []) {
    if (g.projectIds.includes(projectId)) {
      for (const v of g.variables) out[v.key] = decryptSecret(v.valueEnc);
    }
  }
  return out;
}

/**
 * Group routable hostnames by the container port they target and emit Traefik
 * router + service labels — one router per distinct port. A domain with no port
 * override (`port: null`) falls into the project's `defaultPort` group, which
 * reuses `baseKey` as its router/service key so a single-port project produces
 * the exact labels it always did (preserving the no-op reroute detection).
 * Per-port groups beyond the default get a `<baseKey>-<port>` suffix so each
 * Traefik router/service key on the same container is unique.
 *
 * Order is deterministic (default-port group first, then the rest by ascending
 * port) so re-rendering an unchanged routing set yields a byte-identical file.
 */
function traefikRouterLabels(opts: {
  baseKey: string;
  routes: RoutableDomain[];
  defaultPort: number;
}): string[] {
  const { baseKey, routes, defaultPort } = opts;
  // Effective port per host: its override, else the project default.
  const byPort = new Map<number, string[]>();
  for (const r of routes) {
    const p = r.port ?? defaultPort;
    const hosts = byPort.get(p) ?? [];
    hosts.push(r.name);
    byPort.set(p, hosts);
  }
  // Default-port group first, then remaining ports ascending — stable output.
  const ports = [
    ...(byPort.has(defaultPort) ? [defaultPort] : []),
    ...[...byPort.keys()].filter((p) => p !== defaultPort).sort((a, b) => a - b),
  ];
  // With a single router, Traefik auto-binds the same-named service, so the
  // explicit `.service` label is omitted — this keeps the labels byte-identical
  // to the long-standing single-port output, so existing stacks don't see a
  // spurious "changed" file (and pointless restart) on their first reroute.
  // Multiple routers MUST name their service explicitly to disambiguate.
  const multi = ports.length > 1;
  const labels: string[] = ["traefik.enable=true"];
  for (const p of ports) {
    // Non-default port groups suffix the port with `__` — a separator that
    // CANNOT appear in a slug (slugs are [a-z0-9-], see createProject), so
    // `deplo-<slug>__<port>` can never byte-collide with another project's base
    // key `deplo-<otherslug>`. Traefik router/service names are global across
    // every container on the host, so a `-`-only suffix (e.g. `deplo-app-8080`)
    // could equal a sibling project whose slug is literally `app-8080` and
    // cross-route their traffic. The default-port group keeps the bare baseKey
    // (no suffix) to stay byte-identical to the long-standing single-port output.
    const key = p === defaultPort ? baseKey : `${baseKey}__${p}`;
    const rule = (byPort.get(p) ?? [])
      .map((d) => `Host(\`${d}\`)`)
      .join(" || ");
    labels.push(
      `traefik.http.routers.${key}.rule=${rule}`,
      `traefik.http.routers.${key}.entrypoints=websecure`,
      `traefik.http.routers.${key}.tls=true`,
      `traefik.http.routers.${key}.tls.certresolver=${certResolver()}`,
      ...(multi ? [`traefik.http.routers.${key}.service=${key}`] : []),
      `traefik.http.services.${key}.loadbalancer.server.port=${p}`,
    );
  }
  return labels;
}

function renderCompose(opts: {
  name: string;
  image: string;
  port: number;
  projectId: string;
  slug: string;
  /** Public hostnames + per-domain port overrides, primary first. */
  routes: RoutableDomain[];
  env: Record<string, string>;
}): string {
  const { name, image, port, projectId, slug, routes } = opts;
  // Default PORT to the project's default container port so 12-factor apps
  // (buildpacks, Nixpacks, Railpack) bind where Traefik forwards. A user-set
  // PORT wins. Per-domain port overrides only change Traefik's target, not the
  // single PORT the container is told to listen on.
  const env = { PORT: String(port), ...opts.env };
  // Traefik routing (TLS via Let's Encrypt), one router per distinct target
  // port. The global web->websecure redirect is configured on the proxy, so no
  // per-router middleware is needed here.
  const labels = [
    ...traefikRouterLabels({ baseKey: name, routes, defaultPort: port }),
    "deplo.managed=true",
    `deplo.project=${projectId}`,
    `deplo.slug=${slug}`,
  ];
  const labelsYaml = labels.map((l) => `      - "${l}"`).join("\n");
  const envYaml = Object.keys(env).length
    ? "    environment:\n" +
      Object.entries(env)
        .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
        .join("\n") +
      "\n"
    : "";

  return `# Generated by Deplo  ${slug}
services:
  ${name}:
    image: ${image}
    container_name: ${name}
    restart: unless-stopped
    networks:
      - deplo
${envYaml}    labels:
${labelsYaml}

networks:
  deplo:
    external: true
`;
}

async function streamDocker(
  args: string[],
  depId: string,
  timeout: number,
): Promise<void> {
  const code = await spawnStream(
    "docker",
    args,
    (line) => log(depId, "info", line),
    { timeout },
  );
  if (code !== 0) throw new Error(`docker ${args[0]} failed (exit ${code})`);
}

async function waitRunning(name: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await docker(
        ["inspect", "-f", "{{.State.Running}}", name],
        { timeout: 5_000 },
      );
      if (stdout.trim() === "true") return true;
    } catch {
      /* not up yet */
    }
    await sleep(2_000);
  }
  return false;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a deployment record (queued) and kick off the real build in the
 * background. Returns the deployment id immediately; the job updates status and
 * logs as it progresses.
 */
export function startDeployment(
  projectId: string,
  opts: {
    environment?: DeploymentEnvironment;
    creator: string;
    commitMessage?: string;
    branch?: string;
    /** Build PRODUCTION from the dev workspace tree instead of the source. */
    buildSource?: "dev-workspace";
  },
): string {
  const project = read().projects.find((p) => p.id === projectId);
  if (!project) throw new Error("Project not found");
  const server = read().servers.find((s) => s.id === project.serverId);
  const ip = resolveServerIp(server);
  const environment = opts.environment ?? "production";
  const branch = opts.branch ?? project.repo?.branch ?? "main";
  // Production routes through the project's registered primary domain (created
  // here if missing) so the generated hostname is the same one shown in the
  // Domains section and baked into a template's env. Previews are ephemeral.
  const domain =
    environment === "production"
      ? ensureAutoDomain(projectId, { slug: project.slug, ip })
      : previewDomain(project.slug, newId("").slice(1, 7), ip);
  const url = `https://${domain}`;
  const depId = newId("dpl");

  const dep: Deployment = {
    id: depId,
    projectId,
    status: "queued",
    environment,
    commitSha: "",
    commitMessage: opts.commitMessage ?? "Deploy",
    commitAuthor: opts.creator,
    branch,
    url,
    createdAt: nowIso(),
    readyAt: null,
    buildDurationMs: null,
    creator: opts.creator,
    ...(opts.buildSource ? { buildSource: opts.buildSource } : {}),
  };

  mutate((d) => {
    d.deployments.push(dep);
    d.logs[depId] = [];
    const p = d.projects.find((x) => x.id === projectId);
    if (p) {
      p.latestDeploymentId = depId;
      p.status = "queued";
      p.updatedAt = nowIso();
      if (environment === "production") p.productionUrl = url;
    }
  });
  recordActivity("deployment", `Deploying ${project.name}`, opts.creator, projectId);

  // Fire-and-forget: the standalone Node server keeps the event loop alive.
  void runDeployment(depId).catch((e) => {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    setDep(depId, { status: "error" });
  });
  return depId;
}

async function runDeployment(depId: string): Promise<void> {
  const started = Date.now();
  const dep = read().deployments.find((x) => x.id === depId);
  if (!dep) return;
  const project = read().projects.find((p) => p.id === dep.projectId);
  if (!project) {
    setDep(depId, { status: "error" });
    return;
  }
  const slug = project.slug;
  const name = `deplo-${slug}`;
  const stackFile = join(STACK_DIR, `${slug}.yml`);
  const server = read().servers.find((s) => s.id === project.serverId);
  const ip = resolveServerIp(server);
  const domain =
    dep.environment === "production"
      ? ensureAutoDomain(project.id, { slug, ip })
      : dep.url.replace(/^https?:\/\//, "");
  // Production routes to every verified domain (primary first); a preview uses
  // only its ephemeral host (not a registered domain). `domain` is always the
  // canonical primary and the fallback when nothing is verified yet.
  const routeDomains = routableForDeploy(project.id, dep.environment, domain);

  setDep(depId, { status: "building" });
  setProject(project.id, { status: "building" });

  try {
    await mkdir(STACK_DIR, { recursive: true });
    await ensureNetwork("deplo");

    // Multi-service compose / one-click template deploy: deploy the project's
    // own compose stack, wired to Traefik on the generated domain. The compose
    // interpolates its ${VARS} from an env-file we write alongside it. Selecting
    // any other source (git, docker-image, …) switches away from the stack even
    // though the compose is kept for switching back; `source` is authoritative.
    // Legacy template projects predate the `compose` source, so fall back to the
    // old heuristic for them (compose present, no repo/image). An "upload" source
    // is explicit and must build the archive, so the heuristic never claims it —
    // even if a stale compose lingers from a previous source. See usesComposeStack.
    const hasCompose = Boolean(project.compose && project.compose.trim());
    const useCompose = usesComposeStack(project);
    if (useCompose && hasCompose) {
      await deployComposeStack({
        depId,
        project,
        name,
        slug,
        stackFile,
        domain,
        // Compose stacks route via their own service/port model (expose/exposes
        // + host pins); per-domain port overrides apply only to single-image
        // projects, so pass bare hostnames here.
        domains: routeDomains.map((d) => d.name),
        environment: dep.environment,
        started,
      });
      return;
    }

    let imageRef: string;
    let commitSha = "";

    if (dep.buildSource === "dev-workspace") {
      // EXPLICIT exception to "deploy never touches the dev workspace"
      // (CONTEXT.md): build production from the developer's live, edited tree at
      // /data/dev/<slug> — no git clone, no re-extract, no commit. This intent
      // OVERRIDES the project's own source (a git/upload project deploys its
      // workspace here, NOT a fresh clone), so it is checked FIRST. Dev is
      // source-bearing only, so this is always a single-image build; guard
      // against a future source change silently routing a stack through here.
      if (usesComposeStack(project) || project.source === "docker-image") {
        throw new Error(
          "Deploy from dev workspace is only available for built (git/upload) projects",
        );
      }
      const work = await mkdtemp(join(tmpdir(), "deplo-build-"));
      try {
        log(depId, "command", "copy dev workspace");
        // copyWorkspaceForBuild excludes node_modules/.deplo/.deplo-home/.git
        // and rejects any planted symlink (the tree is UID-1000-controlled —
        // same threat model as an upload archive). Dependencies are reinstalled
        // by the build, exactly like a normal deploy.
        const root = await copyWorkspaceForBuild(slug, work, (line) =>
          log(depId, "info", line),
        );

        // Resolve rootDirectory against the copied tree, contained via realpath.
        // Mirror the git arm's explicit hard-fail: this is a user-initiated
        // deploy-to-PRODUCTION, so a typo'd rootDirectory must error loudly
        // rather than silently shipping the workspace root.
        const rootRel = (project.build.rootDirectory || ".")
          .replace(/\\/g, "/")
          .replace(/^\.?\/?/, "");
        const explicitRoot = Boolean(rootRel && rootRel !== ".");
        const candidate = explicitRoot ? join(root, rootRel) : root;
        const buildDir = await safeBuildDir(root, candidate);
        if (
          explicitRoot &&
          buildDir === (await realpath(root).catch(() => root))
        ) {
          throw new Error(
            `rootDirectory "${project.build.rootDirectory}" was not found in the dev workspace`,
          );
        }

        imageRef = `deplo/${slug}:${depId.slice(0, 12)}`;
        await buildImage({
          build: normalizeBuildConfig(project.build),
          workDir: work,
          buildDir,
          slug,
          projectId: project.id,
          imageRef,
          log: (level, text) => log(depId, level, text),
        });
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    } else if (project.source === "docker-image" && project.dockerImage) {
      log(depId, "command", `docker pull ${project.dockerImage}`);
      await streamDocker(["pull", project.dockerImage], depId, 600_000);
      imageRef = project.dockerImage;
    } else if (project.repo) {
      const work = await mkdtemp(join(tmpdir(), "deplo-build-"));
      try {
        // Private GitHub repos clone through the connected App's short-lived
        // installation token; everything else uses the URL as-is. The token is
        // never logged.
        const cloneUrl = await installationCloneUrl(
          project.repo.url,
          project.repo.installationId ?? null,
        );
        log(depId, "command", `git clone ${project.repo.url} (${dep.branch})`);
        await cloneStream(cloneUrl, dep.branch, work, (line) =>
          log(depId, "info", line),
        );
        commitSha = await revParse(work);
        if (commitSha) setDep(depId, { commitSha });

        // Resolve the build dir, guarding against `rootDirectory` escaping the
        // clone — via realpath, so a symlinked dir can't slip past a string
        // prefix check (see safeBuildDir).
        const rootRel = (project.build.rootDirectory || ".")
          .replace(/\\/g, "/")
          .replace(/^\.?\/?/, "");
        const explicitRoot = Boolean(rootRel && rootRel !== ".");
        const candidate = explicitRoot ? join(work, rootRel) : work;
        const buildDir = await safeBuildDir(work, candidate);
        // safeBuildDir falls back to the (canonical) clone root when the
        // candidate doesn't exist or escapes. For an explicitly-set
        // rootDirectory that's a misconfiguration — fail loudly rather than
        // silently building the wrong tree from the repo root.
        if (explicitRoot && buildDir === (await realpath(work).catch(() => work))) {
          throw new Error(
            `rootDirectory "${project.build.rootDirectory}" was not found in the repository`,
          );
        }

        imageRef = `deplo/${slug}:${(commitSha || depId).slice(0, 12)}`;
        // Dispatch to the selected build method (Dockerfile / Nixpacks /
        // Railpack / Heroku|Paketo buildpacks / Static). Each produces imageRef
        // in the local store with the deplo.* labels, listening on build.port.
        await buildImage({
          build: normalizeBuildConfig(project.build),
          workDir: work,
          buildDir,
          slug,
          projectId: project.id,
          imageRef,
          log: (level, text) => log(depId, level, text),
        });
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    } else if (project.source === "upload" && project.upload) {
      // Uploaded archive: extract it into a temp dir, then build it through the
      // exact same path as a git clone. extractArchive rejects any symlink in
      // the archive (so none can be followed out of the temp dir) and may
      // return a subdir (a tarball wrapped in one top-level folder). Resolve
      // `rootDirectory` against THAT root, contained via realpath.
      const work = await mkdtemp(join(tmpdir(), "deplo-build-"));
      try {
        log(depId, "command", `extract ${project.upload.filename}`);
        const root = await extractArchive(project.upload, work, (line) =>
          log(depId, "info", line),
        );

        const rootRel = (project.build.rootDirectory || ".")
          .replace(/\\/g, "/")
          .replace(/^\.?\/?/, "");
        const candidate =
          rootRel && rootRel !== "." ? join(root, rootRel) : root;
        const buildDir = await safeBuildDir(root, candidate);

        imageRef = `deplo/${slug}:${depId.slice(0, 12)}`;
        await buildImage({
          build: normalizeBuildConfig(project.build),
          workDir: work,
          buildDir,
          slug,
          projectId: project.id,
          imageRef,
          log: (level, text) => log(depId, level, text),
        });
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      throw new Error("Nothing to deploy: no Docker image or repository set");
    }

    const env = projectEnv(project.id);
    const composeYaml = renderCompose({
      name,
      image: imageRef,
      port: project.build.port,
      projectId: project.id,
      slug,
      routes: routeDomains,
      env,
    });
    await writeFile(stackFile, composeYaml);

    log(depId, "command", "docker compose up -d");
    await streamDocker(
      ["compose", "-p", name, "-f", stackFile, "up", "-d", "--remove-orphans"],
      depId,
      300_000,
    );

    log(depId, "info", "Waiting for the container to become healthy…");
    const running = await waitRunning(name, 60_000);
    const buildDurationMs = Date.now() - started;

    if (running) {
      setDep(depId, {
        status: "ready",
        readyAt: nowIso(),
        buildDurationMs,
        commitSha: commitSha || dep.commitSha,
      });
      setProject(project.id, {
        status: "active",
        ...(dep.environment === "production" ? { productionUrl: dep.url } : {}),
      });
      log(depId, "info", `Deployment ready at ${dep.url}`);
    } else {
      setDep(depId, { status: "error", buildDurationMs });
      setProject(project.id, { status: "error" });
      log(depId, "error", "Container did not reach a running state");
    }
  } catch (e) {
    log(depId, "error", e instanceof Error ? e.message : String(e));
    setDep(depId, { status: "error", buildDurationMs: Date.now() - started });
    setProject(project.id, { status: "error" });
  }
}

/**
 * Deploy a project's docker-compose stack (templates / multi-service apps).
 * Writes the stack and an env-file next to it, brings it up wired to Traefik on
 * the generated domain, and waits for the exposed service to come up.
 */
async function deployComposeStack(opts: {
  depId: string;
  project: {
    id: string;
    compose: string | null;
    expose: { service: string; port: number } | null;
    exposes?: { service: string; port: number; host?: string }[] | null;
    mounts?: { filePath: string; content: string }[] | null;
  };
  name: string;
  slug: string;
  stackFile: string;
  domain: string;
  /** Public hostnames to route, primary first (no-host routes answer on all). */
  domains: string[];
  environment: DeploymentEnvironment;
  started: number;
}): Promise<void> {
  const {
    depId,
    project,
    name,
    slug,
    stackFile,
    domain,
    domains,
    environment,
    started,
  } = opts;

  // Register every extra hostname a multi-domain template exposes (the primary
  // domain is already registered by the caller) so each shows up in the project's
  // Domains section and Traefik gets a router per host. Production only.
  if (environment === "production") {
    for (const ex of project.exposes ?? []) {
      const host = ex.host?.trim();
      if (host && host !== domain) ensureExtraDomain(project.id, host);
    }
  }

  // Materialise any template config files into the project's isolated files dir
  // (referenced by the compose as ../files/<x>) BEFORE the stack comes up.
  const filesDir = join(STACK_DIR, "files", slug);
  if (project.mounts?.length) {
    await writeMountFiles(filesDir, project.mounts, depId);
  }

  const stackYaml = buildComposeStack({
    compose: project.compose ?? "",
    name,
    slug,
    projectId: project.id,
    domains,
    expose: project.expose ?? null,
    exposes: project.exposes ?? undefined,
    filesDir,
  });
  await writeFile(stackFile, stackYaml);

  // Env-file for ${VAR} interpolation. Written 0600 since it holds secrets.
  const env = projectEnv(project.id);
  const envFile = join(STACK_DIR, `${slug}.env`);
  await writeFile(envFile, renderEnvFile(env), { mode: 0o600 });

  log(depId, "command", "docker compose up -d");
  await streamDocker(
    [
      "compose",
      "-p",
      name,
      "-f",
      stackFile,
      "--env-file",
      envFile,
      "up",
      "-d",
      "--remove-orphans",
    ],
    depId,
    600_000,
  );

  log(depId, "info", "Waiting for the stack to become healthy…");
  const running = await waitStackRunning(slug, 90_000);
  const buildDurationMs = Date.now() - started;
  const url = `https://${domain}`;

  if (running) {
    setDep(depId, { status: "ready", readyAt: nowIso(), buildDurationMs });
    setProject(project.id, {
      status: "active",
      ...(environment === "production" ? { productionUrl: url } : {}),
    });
    log(depId, "info", `Deployment ready at ${url}`);
  } else {
    setDep(depId, { status: "error", buildDurationMs });
    setProject(project.id, { status: "error" });
    log(depId, "error", "Stack did not reach a running state");
  }
}

/**
 * Write template config files into the project's files dir, guarding against
 * path escape. Each filePath is treated as relative to filesDir; any `..`
 * segment or absolute path is rejected.
 */
async function writeMountFiles(
  filesDir: string,
  mounts: { filePath: string; content: string }[],
  depId: string,
): Promise<void> {
  for (const mount of mounts) {
    const rel = mount.filePath.replace(/^\.\/+/, "").replace(/^\/+/, "");
    if (rel.split(/[\\/]/).includes("..") || rel === "") {
      log(depId, "warn", `Skipping unsafe mount path: ${mount.filePath}`);
      continue;
    }
    const target = join(filesDir, rel);
    await mkdir(dirname(target), { recursive: true });
    // 0644: these are bind-mounted into the app container, which may run as a
    // non-root user and must be able to read its own config.
    await writeFile(target, mount.content, { mode: 0o644 });
  }
}

/** Serialize env to docker-compose env-file lines (KEY=VALUE, no quoting). */
function renderEnvFile(env: Record<string, string>): string {
  return (
    Object.entries(env)
      // env-file values are literal; strip newlines that would break the format.
      .map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, " ")}`)
      .join("\n") + "\n"
  );
}

/** Wait for a compose stack's exposed (Traefik-labelled) service to be running. */
async function waitStackRunning(slug: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await docker(
        [
          "ps",
          "-q",
          "--filter",
          `label=deplo.slug=${slug}`,
          "--filter",
          "status=running",
        ],
        { timeout: 5_000 },
      );
      if (stdout.trim()) return true;
    } catch {
      /* not up yet */
    }
    await sleep(2_000);
  }
  return false;
}

function stackFilePath(slug: string): string {
  return join(STACK_DIR, `${slug}.yml`);
}

/**
 * Hostnames to bake into a deploy's Traefik rule. Production routes to every
 * verified domain (primary first) so a later primary-switch / new domain takes
 * effect via a reroute; a preview routes only to its ephemeral host (which is
 * not a registered domain). `primary` is always included as the fallback when
 * the project has no verified domain yet (e.g. the freshly-created auto domain
 * hasn't been marked `valid` on a brand-new project — never emit an empty rule).
 */
function routableForDeploy(
  projectId: string,
  environment: DeploymentEnvironment,
  primary: string,
): RoutableDomain[] {
  // A preview routes only to its ephemeral host, on the project default port.
  if (environment !== "production") return [{ name: primary, port: null }];
  const valid = routableRoutes(projectId);
  if (valid.length === 0) return [{ name: primary, port: null }];
  // Keep the canonical primary first even if it isn't flagged `valid` yet (it
  // carries its own port override if it has one; else the project default).
  const primaryRoute =
    valid.find((d) => d.name === primary) ?? { name: primary, port: null };
  return [primaryRoute, ...valid.filter((d) => d.name !== primary)];
}

/** The `image:` baked into a single-image stack file, so a reroute reuses the
 * exact running image instead of rebuilding. Null if unreadable. */
async function readStackImage(
  stackFile: string,
  service: string,
): Promise<string | null> {
  try {
    const doc = yaml.load(await readFile(stackFile, "utf8")) as {
      services?: Record<string, { image?: unknown }>;
    } | null;
    const svc = doc?.services?.[service];
    return typeof svc?.image === "string" ? svc.image : null;
  } catch {
    return null;
  }
}

/** The `environment:` baked into a single-image stack file (map form, as
 * renderCompose writes it). Lets a reroute preserve the env the container is
 * actually running with instead of shipping pending edits from the store. */
async function readStackEnv(
  stackFile: string,
  service: string,
): Promise<Record<string, string> | null> {
  try {
    const doc = yaml.load(await readFile(stackFile, "utf8")) as {
      services?: Record<string, { environment?: unknown }>;
    } | null;
    const env = doc?.services?.[service]?.environment;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        out[k] = String(v);
      }
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Re-apply a project's Traefik routing to its already-running stack, instantly
 * and without rebuilding. The router's `Host()` rule is baked into the
 * container's labels at deploy time, so switching the primary domain (or adding
 * / removing / verifying one) otherwise needs a full redeploy. This re-renders
 * the on-disk stack file with the project's current verified domains (primary
 * first) and runs `docker compose up -d`, which recreates only the routed
 * service in place; Traefik's Docker provider picks up the new labels within a
 * second or two. No image build, no git clone, no env regeneration.
 *
 * Returns a short status the caller surfaces to the user:
 *  - "rerouted"   — routing was re-applied to the running container
 *  - "unchanged"  — labels already matched; nothing to do (no restart)
 *  - "deferred"   — saved, but routing applies on the next deploy/start because
 *                   the project isn't currently active (idle/building/error) or
 *                   was never deployed; the stack file is still updated so the
 *                   correct labels are in place when it next comes up
 *
 * Throws only on an actual docker failure for an active project, so the caller's
 * toast reflects success/failure. Never starts a stopped (idle) project and
 * never races a deploy in progress (it re-renders the file but skips docker).
 */
export async function rerouteProject(
  projectId: string,
): Promise<"rerouted" | "unchanged" | "deferred"> {
  const project = read().projects.find((p) => p.id === projectId);
  if (!project) return "deferred";
  const slug = project.slug;
  const name = `deplo-${slug}`;
  const stackFile = stackFilePath(slug);

  // Never deployed (or torn down): nothing running to reroute. The domain change
  // is already saved; the next deploy bakes the right labels.
  if (!(await fileExists(stackFile))) return "deferred";

  const routes = routableRoutes(projectId);
  if (routes.length === 0) return "deferred"; // never write an empty Host() rule

  const hasCompose = Boolean(project.compose && project.compose.trim());
  const useCompose = usesComposeStack(project);

  // Re-render the stack file with the new domain set (so the labels are correct
  // whenever the stack next comes up), reusing the running image and env.
  let rendered: string;
  if (useCompose && hasCompose) {
    rendered = buildComposeStack({
      compose: project.compose ?? "",
      name,
      slug,
      projectId,
      // Compose stacks route via their own service/port model; per-domain port
      // overrides apply only to single-image projects.
      domains: routes.map((d) => d.name),
      expose: project.expose ?? null,
      exposes: project.exposes ?? undefined,
      filesDir: join(STACK_DIR, "files", slug),
    });
  } else {
    // Single-image / built path: the image ref and env live only in the stack
    // file (not on the project), so read them back to keep this a pure routing
    // change — never a rebuild or a silent env/image change.
    const image = await readStackImage(stackFile, name);
    if (!image) return "deferred"; // can't safely reroute without the running image
    const env = (await readStackEnv(stackFile, name)) ?? projectEnv(projectId);
    rendered = renderCompose({
      name,
      image,
      port: project.build.port,
      projectId,
      slug,
      routes,
      env,
    });
  }

  // No-op when the labels already match — avoids a pointless container restart
  // (e.g. re-verifying an already-valid domain, or toggling primary back).
  const current = await readFile(stackFile, "utf8").catch(() => "");
  if (current === rendered) return "unchanged";

  await writeFile(stackFile, rendered);

  // Only an active project may be recreated. Recreating an idle (deliberately
  // stopped) project would silently restart it; recreating mid-deploy races the
  // deploy on the same compose project. In both cases the file is now correct
  // and the labels apply on the next start/deploy.
  if (project.status !== "active") return "deferred";

  await ensureNetwork("deplo");
  const args = ["compose", "-p", name, "-f", stackFile];
  if (useCompose && hasCompose) {
    const envFile = join(STACK_DIR, `${slug}.env`);
    if (await fileExists(envFile)) args.push("--env-file", envFile);
  }
  await docker([...args, "up", "-d", "--remove-orphans"], { timeout: 120_000 });
  return "rerouted";
}

/** Stop a project's stack (compose-managed; falls back to the single container). */
export async function stopContainer(slug: string): Promise<void> {
  const stackFile = stackFilePath(slug);
  if (await fileExists(stackFile)) {
    await docker(["compose", "-p", `deplo-${slug}`, "-f", stackFile, "stop"], {
      timeout: 60_000,
    });
    return;
  }
  await docker(["stop", `deplo-${slug}`], { timeout: 30_000 });
}

/** Start a previously stopped stack. */
export async function startContainer(slug: string): Promise<void> {
  const stackFile = stackFilePath(slug);
  if (await fileExists(stackFile)) {
    await docker(["compose", "-p", `deplo-${slug}`, "-f", stackFile, "start"], {
      timeout: 60_000,
    });
    return;
  }
  await docker(["start", `deplo-${slug}`], { timeout: 30_000 });
}

/** Stop and remove a project's stack. */
export async function destroyStack(slug: string): Promise<void> {
  const stackFile = stackFilePath(slug);
  const envFile = join(STACK_DIR, `${slug}.env`);
  const args = ["compose", "-p", `deplo-${slug}`, "-f", stackFile];
  if (await fileExists(envFile)) args.push("--env-file", envFile);
  try {
    await docker([...args, "down", "--remove-orphans"], { timeout: 90_000 });
  } catch {
    // Fall back to removing a single labelled container directly.
    await docker(["rm", "-f", `deplo-${slug}`], { timeout: 30_000 }).catch(
      () => {},
    );
  }
  await rm(stackFile, { force: true }).catch(() => {});
  await rm(envFile, { force: true }).catch(() => {});
  await rm(join(STACK_DIR, "files", slug), {
    recursive: true,
    force: true,
  }).catch(() => {});
}
