import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireExposePorts,
  requireMountHostVolumes,
} from "../membership";
import { composeHasHostBindMount } from "../deploy/compose-lint";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import { buildConfigFor, normalizeBuildConfig } from "../frameworks";
import type {
  BuildConfig,
  Deployment,
  DeploySource,
  EnvTarget,
  FrameworkId,
  GitRepo,
  Project,
  UploadArchive,
  VolumeMount,
} from "../types";
import { usesComposeStack } from "../utils";
import {
  startDeployment,
  stopContainer,
  startContainer,
} from "../deploy/build";
import { ensureAutoDomain } from "./domains";
import { resolveServerIp } from "../deploy/domains";
import { teardownProject } from "./deployments";
import { teardownDev } from "../deploy/dev";
import { removeUploads } from "../deploy/upload";
import { removeProjectDevSshUsers } from "./dev-ssh";
import { isValidLogoValue } from "../projects/logo-shared";

/** Heuristic: treat secret-looking keys as masked secrets. */
function isSecretKey(key: string): boolean {
  return /pass|secret|token|key|api|private|credential|dsn|url/i.test(key);
}

export interface ProjectSummary extends Project {
  latestDeployment: Deployment | null;
  domainCount: number;
}

/** A docker-volume-safe name derived from a mount path when the user left the
 *  name blank (e.g. "/var/data" → "var-data", "/" → "data"). Exported for tests. */
export function deriveVolumeName(mountPath: string): string {
  const s = mountPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "data";
}

/**
 * Backfill/sanitize a project's named volumes on read. Absent ⇒ null (so
 * renderCompose emits nothing and the stack stays byte-identical). Returns the
 * SAME reference when nothing changes so `normalizeProject`'s early-return still
 * fires for the common (modern) row. Entries with no mountPath are dropped;
 * missing id/name are backfilled.
 */
function normalizeVolumes(
  raw: VolumeMount[] | null | undefined,
): VolumeMount[] | null {
  if (!raw || raw.length === 0) return raw == null ? null : raw;
  let changed = false;
  const out: VolumeMount[] = [];
  for (const v of raw) {
    const mountPath = (v?.mountPath ?? "").trim();
    if (!mountPath) {
      changed = true;
      continue;
    }
    const isHost = v?.type === "host";
    const name = (v?.name ?? "").trim() || deriveVolumeName(mountPath);
    const id = v?.id || newId("vol");
    const readOnly = Boolean(v?.readOnly);
    const hostPath = (v?.hostPath ?? "").trim();
    if (
      v.id !== id ||
      v.mountPath !== mountPath ||
      v.name !== name ||
      v.readOnly !== readOnly ||
      (isHost && v.hostPath !== hostPath)
    ) {
      changed = true;
    }
    out.push(
      isHost
        ? { id, type: "host", name, hostPath, mountPath, readOnly }
        : { id, name, mountPath, readOnly },
    );
  }
  return changed ? (out.length ? out : null) : raw;
}

/**
 * Backfill a project read from the store to the current model. The legacy
 * "dockerfile" deploy source was folded into the "dockerfile" build method
 * (build from the repo's Dockerfile is *how* you build, not *where* code comes
 * from), so old projects on that source are remapped to a plain git/github
 * source with their build method forced to "dockerfile". Pure and idempotent.
 */
function normalizeProject<T extends Project>(p: T): T {
  const build = normalizeBuildConfig(p.build);
  const volumes = normalizeVolumes(p.volumes);
  const legacySource = (p.source as string) === "dockerfile";
  if (!legacySource && build === p.build && volumes === p.volumes) return p;
  return {
    ...p,
    source: legacySource
      ? p.repo?.provider === "github"
        ? "github"
        : "git"
      : p.source,
    build: legacySource ? { ...build, buildMethod: "dockerfile" } : build,
    volumes,
  };
}

function summarize(p: Project): ProjectSummary {
  const d = read();
  const np = normalizeProject(p);
  const latest = np.latestDeploymentId
    ? d.deployments.find((x) => x.id === np.latestDeploymentId) || null
    : null;
  return {
    ...np,
    // Projects created before the logo field have it absent; surface an explicit
    // null so every consumer reads a defined `string | null`.
    logo: np.logo ?? null,
    latestDeployment: latest,
    domainCount: d.domains.filter((x) => x.projectId === np.id).length,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const teamId = await requireActiveTeamId();
  return read()
    .projects.filter((p) => p.teamId === teamId)
    .map(summarize)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getProjectBySlug(
  slug: string
): Promise<ProjectSummary | null> {
  const teamId = await requireActiveTeamId();
  const p = read().projects.find((x) => x.slug === slug);
  return p && p.teamId === teamId ? summarize(p) : null;
}

export async function getProjectById(id: string): Promise<Project | null> {
  const teamId = await requireActiveTeamId();
  const p = read().projects.find((x) => x.id === id);
  return p && p.teamId === teamId ? normalizeProject(p) : null;
}

export interface CreateProjectInput {
  name: string;
  framework: FrameworkId;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage?: string | null;
  /** Display logo (URL/path), defaulted from a template's logo on deploy. */
  logo?: string | null;
  compose?: string | null;
  env?: { key: string; value: string }[];
  serverId?: string;
  build?: Partial<BuildConfig>;
  autoDeploy?: boolean;
  /** Compose/template deploys: which service + port Traefik exposes. */
  composeService?: string | null;
  composePort?: number | null;
  /** Every publicly-routed service in the stack (each with its own host). */
  exposes?: { service: string; port: number; host?: string }[] | null;
  /** Pre-generated domain a template baked into its env; kept consistent. */
  autoDomain?: string | null;
  /** Template config files to materialise at deploy time. */
  mounts?: { filePath: string; content: string }[] | null;
}

export async function createProject(
  input: CreateProjectInput
): Promise<ProjectSummary> {
  const { membership } = await requireCapability("deploy");
  // Publishing a compose service port is a port-exposure action; a single-image
  // project's build.port is the intrinsic route Traefik targets, not an extra
  // published port, so it isn't gated here.
  if ((input.composeService && input.composePort) || input.exposes?.length) {
    await requireExposePorts();
  }
  // A host bind mount baked into the initial compose needs the host-volume grant.
  if (input.compose != null && composeHasHostBindMount(input.compose)) {
    await requireMountHostVolumes();
  }
  const user = read().users.find((u) => u.id === membership.userId)!;
  const slugBase = input.name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const existing = new Set(read().projects.map((p) => p.slug));
  let slug = slugBase || `project-${newId("").slice(1, 6)}`;
  let i = 1;
  while (existing.has(slug)) slug = `${slugBase}-${i++}`;

  const servers = read().servers;
  // Default to the master (localhost) server; honour an explicit, existing pick.
  const server =
    (input.serverId && servers.find((s) => s.id === input.serverId)) ||
    servers.find((s) => s.type === "localhost") ||
    servers[0];
  const project: Project = {
    id: newId("prj"),
    name: input.name.trim(),
    slug,
    teamId: membership.teamId,
    serverId: server.id,
    framework: input.framework,
    // Defaulted from a template's logo (a /templates path); ignore anything that
    // isn't a valid inline logo so a crafted create payload can't store a URL.
    logo: input.logo && isValidLogoValue(input.logo) ? input.logo : null,
    source: input.source,
    repo: input.repo,
    dockerImage: input.dockerImage ?? null,
    upload: null,
    compose: input.compose ?? null,
    expose:
      input.composeService && input.composePort
        ? { service: input.composeService, port: input.composePort }
        : null,
    exposes: input.exposes?.length ? input.exposes : null,
    mounts: input.mounts?.length ? input.mounts : null,
    build: buildConfigFor(input.framework, input.build),
    productionUrl: null,
    status: "queued",
    autoDeploy: input.autoDeploy ?? true,
    latestDeploymentId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  // Initial environment variables (e.g. a template's defaults), encrypted at rest.
  const now = nowIso();
  const envVars = (input.env ?? [])
    .filter((e) => e.key.trim())
    .map((e) => ({
      id: newId("env"),
      projectId: project.id,
      key: e.key.trim(),
      valueEnc: encryptSecret(e.value),
      targets: ["production", "preview", "development"] as EnvTarget[],
      type: isSecretKey(e.key) ? ("secret" as const) : ("plain" as const),
      createdAt: now,
      updatedAt: now,
    }));

  mutate((d) => {
    d.projects.push(project);
    d.envVars.push(...envVars);
  });
  recordActivity("project", `Created project ${project.name}`, user.name, project.id);

  // Register the generated sslip.io domain so it shows up in the project's
  // Domains section immediately and the deploy routes to the same hostname a
  // template baked into its env.
  const ip = resolveServerIp(server);
  ensureAutoDomain(project.id, {
    slug,
    ip,
    preferred: input.autoDomain ?? undefined,
  });

  // An "upload" project has no archive at creation (it is uploaded from the
  // Settings page afterward, which triggers its own deploy via the upload
  // route). Deploying now would fail with "Nothing to deploy", so leave it
  // idle instead of stuck queued / errored.
  if (project.source === "upload") {
    mutate((d) => {
      const p = d.projects.find((x) => x.id === project.id);
      if (p) p.status = "idle";
    });
  } else {
    // Kick off the first real build + deploy. Runs in the background and flips
    // the project to active (or error) once the container is up.
    startDeployment(project.id, {
      environment: "production",
      creator: user.name,
      commitMessage: input.repo ? "Initial import" : "Initial deployment",
    });
  }

  return summarize(read().projects.find((x) => x.id === project.id)!);
}

export async function updateProjectBuild(
  id: string,
  build: Partial<BuildConfig>
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  // Changing which container port Traefik routes to is a port-exposure action;
  // gate only on an actual change so ordinary build-setting edits (commands,
  // build method, …) stay open to anyone who can deploy.
  const target = read().projects.find(
    (x) => x.id === id && x.teamId === membership.teamId,
  );
  if (
    target &&
    build.port !== undefined &&
    build.port !== target.build.port
  ) {
    await requireExposePorts();
  }
  const user = read().users.find((u) => u.id === membership.userId)!;
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id && x.teamId === membership.teamId);
    if (!p) throw new Error("Project not found");
    p.build = { ...p.build, ...build };
    p.framework = build.framework ?? p.framework;
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Updated build settings`, user.name, id);
}

export interface UpdateSourceInput {
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  serverId?: string;
  /** Compose YAML to persist (source === "compose"). Kept when switching away. */
  compose?: string | null;
  /** Which service + port Traefik exposes for the compose stack. */
  expose?: { service: string; port: number } | null;
  /** Every publicly-routed service in the stack (multi-domain templates). */
  exposes?: { service: string; port: number; host?: string }[] | null;
}

export async function updateProjectSource(
  id: string,
  input: UpdateSourceInput
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  // Setting a compose service to publish a port requires the expose-ports grant.
  if (
    (input.expose !== undefined && input.expose !== null) ||
    (input.exposes !== undefined && (input.exposes?.length ?? 0) > 0)
  ) {
    await requireExposePorts();
  }
  // Saving compose YAML that bind-mounts a host path requires the host grant.
  if (input.compose != null && composeHasHostBindMount(input.compose)) {
    await requireMountHostVolumes();
  }
  const user = read().users.find((u) => u.id === membership.userId)!;
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id && x.teamId === membership.teamId);
    if (!p) throw new Error("Project not found");
    if (input.serverId) {
      const server = d.servers.find((s) => s.id === input.serverId);
      if (!server) throw new Error("Server not found");
      p.serverId = server.id;
    }
    p.source = input.source;
    p.repo = input.repo;
    p.dockerImage = input.dockerImage;
    // Persist compose edits when provided; never clear a stored stack on switch
    // so the user can flip back to the Compose source and recover it.
    if (input.compose != null) p.compose = input.compose;
    if (input.expose !== undefined) p.expose = input.expose;
    if (input.exposes !== undefined) p.exposes = input.exposes;
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Updated deploy source`, user.name, id);
}

/**
 * Container paths the runtime owns; mounting a user volume over them would break
 * or compromise the container. Rejected (exact match or as a parent prefix).
 */
const RESERVED_MOUNT_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var/run",
];

/**
 * Validate + canonicalize the full volume set for a single-container project.
 * The renderer trusts its input, so EVERY safety rule lives here:
 *  - mountPath absolute, no spaces, no ":" (would smuggle a `:ro`/extra field
 *    into the compose `- name:path` string), no "..", not a reserved path.
 *  - no mountPath collision with a template `mounts[].filePath` (those are
 *    bind-mounted config files written next to the stack).
 *  - name lowercased, `[a-z0-9][a-z0-9_-]*`, ≤40 (blocks YAML key injection into
 *    the top-level `  <name>:` map), derived from the path when blank.
 *  - mountPath AND name unique within the project.
 * For a HOST bind mount (`type: "host"`) the `hostPath` SOURCE is validated to be
 * an absolute path with no spaces/":"/".." (so it can't smuggle extra compose
 * fields) — but it is intentionally NOT subject to RESERVED_MOUNT_PREFIXES (those
 * guard the in-container target; a privileged user picks the host source on
 * purpose). The grant check that authorizes host mounts lives in the CALLER
 * (setProjectVolumes), not here, so this stays a pure validator usable in tests.
 * Empty result ⇒ null so renderCompose stays byte-identical. Exported for tests.
 */
export function validateVolumes(
  raw: VolumeMount[],
  existingMounts: { filePath: string }[] | null | undefined,
): VolumeMount[] | null {
  const seenPath = new Set<string>();
  const seenName = new Set<string>();
  const mountFilePaths = (existingMounts ?? []).map((m) => m.filePath);
  const out: VolumeMount[] = [];
  for (const v of raw) {
    const mountPath = (v.mountPath ?? "").trim().replace(/\/+$/, "") || "/";
    if (!/^\/[^\s:]*$/.test(mountPath) || mountPath.length < 2) {
      throw new Error(
        `Mount path must be an absolute path with no spaces or ":": "${v.mountPath}"`,
      );
    }
    if (mountPath.split("/").includes("..")) {
      throw new Error(`Mount path must not contain "..": "${v.mountPath}"`);
    }
    if (
      RESERVED_MOUNT_PREFIXES.some(
        (r) => mountPath === r || mountPath.startsWith(r + "/"),
      )
    ) {
      throw new Error(`Mount path "${mountPath}" is reserved by the system.`);
    }
    // A volume conflicts with a template config file when their paths are equal,
    // when the volume is INSIDE a config file's dir, OR when the volume's dir
    // would SHADOW (contain) a config file — any of which breaks the bind-mount.
    if (
      mountFilePaths.some((raw) => {
        const f = raw.replace(/\/+$/, "");
        return (
          f === mountPath ||
          mountPath.startsWith(f + "/") ||
          f.startsWith(mountPath + "/")
        );
      })
    ) {
      throw new Error(
        `Mount path "${mountPath}" conflicts with a template config file.`,
      );
    }
    if (seenPath.has(mountPath)) {
      throw new Error(`Duplicate mount path: "${mountPath}"`);
    }
    seenPath.add(mountPath);

    const name = ((v.name ?? "").trim() || deriveVolumeName(mountPath)).toLowerCase();

    if (v.type === "host") {
      // Host bind mount: validate the host SOURCE path the same way as the
      // target (absolute, no spaces/":"/".."), but it is NOT reserved-prefix
      // checked — the source is a deliberate host path. No top-level volumes
      // entry is emitted, so docker-name rules don't apply.
      const hostPath = (v.hostPath ?? "").trim().replace(/\/+$/, "");
      if (!/^\/[^\s:]*$/.test(hostPath) || hostPath.length < 2) {
        throw new Error(
          `Host path must be an absolute path with no spaces or ":": "${v.hostPath}"`,
        );
      }
      if (hostPath.split("/").includes("..")) {
        throw new Error(`Host path must not contain "..": "${v.hostPath}"`);
      }
      out.push({
        id: v.id || newId("vol"),
        type: "host",
        name,
        hostPath,
        mountPath,
        readOnly: Boolean(v.readOnly),
      });
      continue;
    }

    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || name.length > 40) {
      throw new Error(
        `Volume name "${name}" must be lowercase letters, digits, "-"/"_" (max 40).`,
      );
    }
    if (seenName.has(name)) {
      throw new Error(`Duplicate volume name: "${name}"`);
    }
    seenName.add(name);

    out.push({ id: v.id || newId("vol"), name, mountPath, readOnly: Boolean(v.readOnly) });
  }
  return out.length ? out : null;
}

/**
 * Replace a single-container project's volumes (full set) — docker-managed named
 * volumes and (for privileged users) host bind mounts. Rejected for compose-stack
 * projects — they declare volumes inside their own YAML. An empty set is stored
 * as null so renderCompose stays byte-identical. Persists only; the new mounts
 * take effect on the next production deploy (consistent with the other per-card
 * settings mutations).
 */
export async function setProjectVolumes(
  id: string,
  volumes: VolumeMount[],
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  // A host bind mount escapes the per-project sandbox, so it needs the dedicated
  // grant on top of `deploy` (instance admins hold it implicitly).
  if (volumes.some((v) => v.type === "host")) {
    await requireMountHostVolumes();
  }
  const user = read().users.find((u) => u.id === membership.userId)!;
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id && x.teamId === membership.teamId);
    if (!p) throw new Error("Project not found");
    if (usesComposeStack(p)) {
      throw new Error(
        "Volumes are managed inside the compose file for this project.",
      );
    }
    // Validate here (inside mutate) so the conflict check can read p.mounts.
    p.volumes = validateVolumes(volumes, p.mounts);
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Updated volumes`, user.name, id);
}

/**
 * Point a project at a freshly uploaded archive and switch its source to
 * "upload". Called by the upload route handler after the file is on disk; the
 * route then triggers a deploy that extracts and builds it. Forgets any repo /
 * docker image so the deploy pipeline takes the upload branch unambiguously.
 */
export async function setProjectUpload(
  id: string,
  upload: UploadArchive,
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = read().users.find((u) => u.id === membership.userId)!;
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id && x.teamId === membership.teamId);
    if (!p) throw new Error("Project not found");
    p.source = "upload";
    p.upload = upload;
    p.repo = null;
    p.dockerImage = null;
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Uploaded ${upload.filename}`, user.name, id);
}

export async function setAutoDeploy(id: string, value: boolean): Promise<void> {
  const { membership } = await requireCapability("deploy");
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id && x.teamId === membership.teamId);
    if (!p) throw new Error("Project not found");
    p.autoDeploy = value;
    p.updatedAt = nowIso();
  });
}

export async function renameProject(id: string, name: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = read().users.find((u) => u.id === membership.userId)!;
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id && x.teamId === membership.teamId);
    if (!p) throw new Error("Project not found");
    p.name = name.trim();
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Renamed project to ${name}`, user.name, id);
}

/**
 * Set (or clear) the project's display logo. An empty value clears it, falling
 * the UI back to the framework icon. The logo is stored INLINE on the project
 * as a base64 image data-URI (uploaded image) or a local /templates path
 * (template default) — never a remote URL, so it renders under the strict CSP
 * with no cross-origin fetch (see {@link isValidLogoValue}). Purely cosmetic:
 * it never touches the deploy source or the Docker image the stack runs.
 *
 * No-op (no updatedAt bump, no activity record) when the value is unchanged, so
 * an idle Save doesn't reorder the dashboard or write a spurious log line.
 */
export async function updateProjectLogo(
  id: string,
  logo: string | null,
): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const next = logo?.trim() ? logo.trim() : null;
  if (next && !isValidLogoValue(next)) {
    throw new Error("Unsupported logo image");
  }
  let changed = false;
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id && x.teamId === membership.teamId);
    if (!p) throw new Error("Project not found");
    if ((p.logo ?? null) === next) return;
    p.logo = next;
    p.updatedAt = nowIso();
    changed = true;
  });
  if (changed) recordActivity("project", `Updated project logo`, user.name, id);
}

/** Stop the project's running container. */
export async function stopProject(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const project = read().projects.find(
    (x) => x.id === id && x.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");
  await stopContainer(project.slug).catch(() => {});
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id)!;
    p.status = "idle";
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Stopped ${project.name}`, user.name, id);
}

/** Start a previously stopped project's container. */
export async function startProject(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const project = read().projects.find(
    (x) => x.id === id && x.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");
  await startContainer(project.slug).catch(() => {});
  mutate((d) => {
    const p = d.projects.find((x) => x.id === id)!;
    p.status = "active";
    p.updatedAt = nowIso();
  });
  recordActivity("project", `Started ${project.name}`, user.name, id);
}

/** Rebuild the image from the current source and redeploy (real build). */
export async function rebuildProject(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const project = read().projects.find(
    (x) => x.id === id && x.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");
  startDeployment(id, {
    environment: "production",
    creator: user.name,
    commitMessage: "Rebuild container",
  });
}

export async function deleteProject(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const project = read().projects.find(
    (x) => x.id === id && x.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");
  // Tear down the running container/stack before dropping the records.
  await teardownProject(project.slug);
  // Dev mode: tear down the dev container + deps volume + WIPE the workspace
  // (the project is gone), and remove this project's SSH users from the gateway
  // (which stays up — it is a platform singleton).
  await teardownDev(project.slug).catch(() => {});
  await removeProjectDevSshUsers(id).catch(() => {});
  // Drop any uploaded archive backing an "upload" source.
  await removeUploads(id).catch(() => {});
  mutate((d) => {
    d.projects = d.projects.filter((x) => x.id !== id);
    const depIds = d.deployments.filter((x) => x.projectId === id).map((x) => x.id);
    d.deployments = d.deployments.filter((x) => x.projectId !== id);
    for (const depId of depIds) delete d.logs[depId];
    d.envVars = d.envVars.filter((x) => x.projectId !== id);
    d.domains = d.domains.filter((x) => x.projectId !== id);
  });
  recordActivity("project", `Deleted project ${project.name}`, user.name, null);
}
