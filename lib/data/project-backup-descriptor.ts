import "server-only";

import yaml from "js-yaml";

import { read } from "../store";
import { decryptSecret } from "../crypto";
import { hostVolumeName, usesComposeStack } from "../utils";
import { resolveEnvEntries } from "../deploy/env-resolve";
import { connectAgent } from "../infra/agent-client";
import type { Project, VolumeMount } from "../types";

/**
 * Build the {@link ProjectDescriptor} the agent's Backup/Restore RPC needs from a
 * project, resolving Deplo's three persistent-state shapes into a FLAT list of
 * on-host docker volume names plus the files-dir flag and the compose/env
 * snapshot. The agent stays dumb about Deplo's volume-naming scheme: it tars/wipes
 * each name in `volumeNames` verbatim (mounting `-v <name>:/v`), so this builder
 * is the single place that must get the host names exactly right — a wrong name
 * silently backs up nothing (or, on restore, wipes the wrong volume).
 *
 * The descriptor's shape mirrors the wire `ProjectDescriptor` but stays a plain
 * structural type here (the data layer maps it 1:1 into the protobuf message),
 * matching how the rest of agent-client keeps gen types out of the data layer.
 */
export interface ProjectBackupDescriptor {
  slug: string;
  /** On-host docker volume names to tar (named + compose-stack; host mounts excluded). */
  volumeNames: string[];
  /** Include the project files dir (<stacks>/files/<slug>) in the archive. */
  includeFiles: boolean;
  /** Rendered compose YAML captured into the archive for the restore re-Reroute. */
  composeYaml: string;
  /** Decrypted env snapshot (KEY -> VALUE) for the restore re-Reroute. */
  envSnapshot: Record<string, string>;
  /** Template config-file mounts to re-materialise on restore. */
  mounts: { path: string; content: string }[];
}

/**
 * The exact decrypted env a project runs with in production — the snapshot the
 * restore re-Reroutes. Replicates build.ts's private `projectEnv` (production
 * target) so a backup captures EXACTLY what a production deploy would inject:
 * per-project vars + attached shared groups, decrypted at this edge. Secrets are
 * decrypted here because the agent must write the real `.env` on restore; they
 * ride the same mTLS channel as the S3 creds and the DB password.
 */
export function projectEnvSnapshot(projectId: string): Record<string, string> {
  const d = read();
  const out: Record<string, string> = {};
  for (const e of resolveEnvEntries(
    "production",
    projectId,
    d.envVars,
    d.sharedEnvGroups ?? [],
  )) {
    out[e.key] = decryptSecret(e.valueEnc);
  }
  return out;
}

/**
 * The on-host docker volume names for a SINGLE-CONTAINER project's named volumes.
 * The renderCompose path namespaces each named volume per project as
 * `hostVolumeName(slug, name)` = `deplo-<slug>-<name>` (pinned via `name:` in the
 * top-level volumes block), so we compute that directly from the stored mounts —
 * no YAML round-trip needed. `type === "host"` mounts are EXCLUDED (shared
 * cross-tenant host paths, outside Deplo); `type === "project"` mounts live under
 * the files dir and are captured by `includeFiles`, not as volumes.
 */
export function namedVolumeHostNames(
  slug: string,
  volumes: VolumeMount[] | null | undefined,
): string[] {
  return (volumes ?? [])
    .filter((v) => (v.type ?? "named") === "named")
    .map((v) => hostVolumeName(slug, v.name));
}

/**
 * The on-host docker volume names for a COMPOSE-STACK project, parsed from the
 * rendered stack YAML's TOP-LEVEL `volumes:` block.
 *
 * Unlike the single-container renderer, `buildComposeStack` does NOT rewrite a
 * compose-stack project's own `volumes:` — the user's declarations pass through
 * untouched. So the on-host name of each declared volume follows Docker Compose's
 * own rule, reproduced here:
 *  - an explicit `name:` on the volume wins verbatim (the user/operator pinned a
 *    fixed host name);
 *  - otherwise Compose namespaces it as `<project>_<key>`, and the project is
 *    always `deplo-<slug>` (the `-p deplo-<slug>` the agent runs every compose
 *    command with), so the host name is `deplo-<slug>_<key>`.
 *  - `external: true` volumes are pre-existing host volumes Deplo doesn't own:
 *    their host name is the explicit `name:` if set, else the bare key (Compose
 *    does NOT project-prefix an external volume). We still back them up (they hold
 *    the stack's data) but never project-prefix them.
 *
 * A volume entry that is `null`/`{}` (the common `myvol: {}` shape) has no `name:`
 * and is not external, so it resolves to `deplo-<slug>_<key>`.
 */
export function composeStackVolumeHostNames(
  slug: string,
  renderedYaml: string,
): string[] {
  let doc: unknown;
  try {
    doc = yaml.load(renderedYaml);
  } catch {
    return [];
  }
  const volumes = (doc as { volumes?: unknown } | null)?.volumes;
  if (!volumes || typeof volumes !== "object") return [];
  const names: string[] = [];
  for (const [key, spec] of Object.entries(volumes as Record<string, unknown>)) {
    const s = (spec ?? {}) as {
      name?: unknown;
      external?: unknown;
    };
    // A top-level `name:` pins the host volume name verbatim (external or not).
    if (typeof s.name === "string" && s.name) {
      names.push(s.name);
      continue;
    }
    // `external` can be `true` (bool) or, in the deprecated long form, an object
    // that may itself carry a `name`. An external volume is a pre-existing host
    // volume Deplo doesn't own: its name is `external.name` if given, else the
    // bare key — NEVER project-prefixed (Compose doesn't prefix externals).
    if (s.external && typeof s.external === "object") {
      const ext = s.external as { name?: unknown };
      names.push(typeof ext.name === "string" && ext.name ? ext.name : key);
      continue;
    }
    if (s.external === true) {
      names.push(key);
      continue;
    }
    // A Deplo-owned (non-external, unnamed) volume gets Compose's default
    // `<project>_<key>` name, and the project is always `deplo-<slug>`.
    names.push(`deplo-${slug}_${key}`);
  }
  return names;
}

/**
 * The exact shape a Docker named volume must have, MIRRORING the agent's
 * `volumeNamePattern` (deplo-agent backup_tar.go) so the control plane rejects a
 * bad name with an actionable message INSTEAD of letting the agent fail opaquely
 * mid-stream ("unsafe volume name") after it has already started archiving. A
 * name that fails here would be bind-mounted as a host path or rejected agent-
 * side, so it must never reach the wire. (The agent re-validates regardless —
 * this is defence in depth + a clear UX, not the only gate.)
 */
const AGENT_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Validate every resolved host volume name against the agent's rule, throwing a
 * clear, actionable error on the first bad one. The usual culprit is a compose
 * `volumes:` entry with an INTERPOLATED explicit name (`name: ${VAR}`) — Compose
 * resolves `${VAR}` only at `docker compose` runtime, so the rendered YAML still
 * carries the literal `${VAR}`, which is not a legal docker volume name. Rather
 * than back up the wrong (or no) volume, we refuse with guidance.
 */
export function assertSafeVolumeNames(slug: string, names: string[]): void {
  for (const name of names) {
    if (!AGENT_VOLUME_NAME.test(name) || name.includes("..")) {
      const interpolated = name.includes("${");
      throw new Error(
        `Project "${slug}" declares a volume whose host name "${name}" ` +
          (interpolated
            ? `uses a compose variable (\${...}) that Deplo can't resolve for a backup. ` +
              `Give that volume a literal name: in the compose, or remove the explicit name so Deplo derives it.`
            : `is not a valid Docker volume name. Rename it to letters, digits, ` +
              `'_', '.' or '-' (starting with a letter or digit).`),
      );
    }
  }
}

/**
 * Build the full backup descriptor for a project. For a compose-stack project the
 * rendered YAML (the source of truth for the host volume names AND the snapshot)
 * is read back from the OWNING agent via `readStack`; for a single-container
 * project the volume names are derived from the stored mounts and the snapshot is
 * still read from the agent so the archive captures the EXACT deployed config.
 *
 * Throws {@link AgentUnreachableError} (from `connectAgent`) when the owning
 * server's agent can't be reached, or a clear validation error when a resolved
 * volume name is not agent-safe (e.g. an interpolated compose volume name).
 */
export async function buildProjectDescriptor(
  project: Project,
): Promise<ProjectBackupDescriptor> {
  const slug = project.slug;
  const composeStack = usesComposeStack(project);

  // The rendered stack on the agent's disk is the snapshot we capture and, for a
  // compose-stack project, the source for the host volume names. Read it once.
  const conn = await connectAgent(project.serverId);
  let stack: { exists: boolean; yaml: string };
  try {
    stack = await conn.readStack(slug);
  } finally {
    conn.close();
  }

  const composeYaml = stack.exists ? stack.yaml : "";
  const volumeNames = composeStack
    ? composeStackVolumeHostNames(slug, composeYaml)
    : namedVolumeHostNames(slug, project.volumes);
  // Fail fast with a clear message before any agent work, rather than letting the
  // agent reject a bad name opaquely after it starts streaming the archive.
  assertSafeVolumeNames(slug, volumeNames);

  return {
    slug,
    volumeNames,
    // Single-container projects keep their config files under the files dir only
    // when they have project-path mounts or `mounts`; a compose-stack project's
    // `./` bind mounts also land there. Including the dir is cheap and the agent
    // no-ops when it's absent, so include it whenever the project could have one.
    includeFiles: projectHasFilesDir(project),
    composeYaml,
    envSnapshot: projectEnvSnapshot(project.id),
    mounts: (project.mounts ?? []).map((m) => ({
      path: m.filePath,
      content: m.content,
    })),
  };
}

/**
 * Whether a project could have a files dir (<stacks>/files/<slug>) worth
 * archiving: a compose-stack project (its `./x` bind mounts + template mounts
 * live there), any project with template `mounts`, or any with a `project`-type
 * volume mount. The agent stats the dir and no-ops if it's absent, so a false
 * positive only costs an empty stat — but skipping a real files dir would lose
 * config, so we err toward including it.
 */
function projectHasFilesDir(project: Project): boolean {
  if (usesComposeStack(project)) return true;
  if ((project.mounts ?? []).length > 0) return true;
  return (project.volumes ?? []).some((v) => v.type === "project");
}
