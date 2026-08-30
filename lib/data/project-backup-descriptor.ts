// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import yaml from "../yaml";

import { decryptSecretOrThrow } from "../crypto";
import { hostVolumeName, usesComposeStack } from "../utils";
import { resolveEnvEntries } from "../deploy/env-resolve";
import { loadEnvVarsForApp } from "./app-graph-load";
import {
  loadAutoInjectedVarsForApp,
  loadSharedVarsForApp,
} from "./shared-vars";
import { connectAgent } from "../infra/agent-client";
import type { App, VolumeMount } from "../types";

/**
 * Build the {@link ProjectDescriptor} the agent's Backup/Restore RPC needs from a
 * project, resolving Deplo's three persistent-state shapes into a FLAT list of
 * on-host docker volume names plus the files-dir flag and the compose/env
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
 * The exact decrypted env a project runs with in production - the snapshot the
 * restore re-Reroutes.
 */
export async function appEnvSnapshot(
  appId: string,
): Promise<Record<string, string>> {
  const [vars, sharedVars, autoInjected] = await Promise.all([
    loadEnvVarsForApp(appId),
    loadSharedVarsForApp(appId),
    loadAutoInjectedVarsForApp(appId),
  ]);
  const out: Record<string, string> = {};
  for (const e of resolveEnvEntries(
    "production",
    appId,
    vars,
    sharedVars,
    autoInjected,
  )) {
    // Strict: this descriptor is what a RESTORE writes back as the app's real
    // `.env`, so a value that silently became "" would not break the backup -
    // it would break the recovery, months later, at the worst possible moment.
    out[e.key] = decryptSecretOrThrow(e.valueEnc, `The variable ${e.key}`);
  }
  return out;
}

/**
 * The on-host docker volume names for a SINGLE-CONTAINER project's named volumes.
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
 * rendered stack YAML's TOP-LEVEL `volumes:` block. We still back them up (they
 * hold the stack's data) but never project-prefix them.
 */
/**
 * Deplo owns the `deplo-` host-volume namespace: every per-app volume it derives
 * lives there (`deplo-<slug>_<key>` for compose, `deplo-<slug>-<name>` for single-
 * container).
 */
function assertNotReservedVolumeName(
  slug: string,
  name: string,
  own: ReadonlySet<string>,
): void {
  if (name.startsWith("deplo-") && !own.has(name))
    throw new Error(
      `App "${slug}" pins a volume name "${name}" inside Deplo's reserved ` +
        `namespace ("deplo-…"). Use a name of your own, or omit the explicit ` +
        `name so Deplo derives a per-app one.`,
    );
}

export function composeStackVolumeHostNames(
  slug: string,
  renderedYaml: string,
  /** Host names Deplo pinned itself (see {@link assertNotReservedVolumeName}). */
  ownNames?: Iterable<string> | null,
): string[] {
  const own = new Set(ownNames ?? []);
  let doc: unknown;
  try {
    doc = yaml.load(renderedYaml);
  } catch {
    return [];
  }
  const volumes = (doc as { volumes?: unknown } | null)?.volumes;
  if (!volumes || typeof volumes !== "object") return [];
  const names: string[] = [];
  for (const [key, spec] of Object.entries(
    volumes as Record<string, unknown>,
  )) {
    const s = (spec ?? {}) as {
      name?: unknown;
      external?: unknown;
    };
    // A top-level `name:` pins the host volume name verbatim (external or not).
    if (typeof s.name === "string" && s.name) {
      assertNotReservedVolumeName(slug, s.name, own);
      names.push(s.name);
      continue;
    }
    // `external` can be `true` (bool) or, in the deprecated long form, an object that
    // may itself carry a `name`.
    if (s.external && typeof s.external === "object") {
      const ext = s.external as { name?: unknown };
      const n = typeof ext.name === "string" && ext.name ? ext.name : key;
      assertNotReservedVolumeName(slug, n, own);
      names.push(n);
      continue;
    }
    if (s.external === true) {
      assertNotReservedVolumeName(slug, key, own);
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
 */
const AGENT_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Validate every resolved host volume name against the agent's rule, throwing a
 * clear, actionable error on the first bad one.
 */
export function assertSafeVolumeNames(slug: string, names: string[]): void {
  for (const name of names) {
    if (!AGENT_VOLUME_NAME.test(name) || name.includes("..")) {
      const interpolated = name.includes("${");
      throw new Error(
        `App "${slug}" declares a volume whose host name "${name}" ` +
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
 * The on-host docker volume names to COPY on an app server MOVE. Names are
 * validated with {@link assertSafeVolumeNames} by the caller before they reach the
 * wire.
 */
export function appMoveVolumeNames(
  project: App,
  renderedYaml: string,
): string[] {
  const slug = project.slug;
  if (!usesComposeStack(project)) {
    // Single-container: only pinned `name:` named volumes (host mounts already
    // excluded by namedVolumeHostNames). None of these are ever "external".
    return namedVolumeHostNames(slug, project.volumes);
  }
  // Compose-stack: re-derive from the rendered YAML but drop external volumes.
  let doc: unknown;
  try {
    doc = yaml.load(renderedYaml);
  } catch {
    return [];
  }
  const volumes = (doc as { volumes?: unknown } | null)?.volumes;
  if (!volumes || typeof volumes !== "object") return [];
  // The stack's own Storage-settings volumes are pinned inside Deplo's namespace
  // BY Deplo - they must move with the app, not trip the reserved-name guard.
  const own = new Set(namedVolumeHostNames(slug, project.volumes));
  const names: string[] = [];
  for (const [key, spec] of Object.entries(
    volumes as Record<string, unknown>,
  )) {
    const s = (spec ?? {}) as { name?: unknown; external?: unknown };
    // Skip external volumes - Deplo doesn't own them, so a move must not relocate
    // them (they stay the operator's responsibility on whatever host declares them).
    if (s.external === true || (s.external && typeof s.external === "object")) {
      continue;
    }
    if (typeof s.name === "string" && s.name) {
      assertNotReservedVolumeName(slug, s.name, own);
      names.push(s.name);
      continue;
    }
    names.push(`deplo-${slug}_${key}`);
  }
  return names;
}

/**
 * Build the full backup descriptor for a project.
 */
export async function buildProjectDescriptor(
  project: App,
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
    ? // The app's Storage volumes are pinned by the RENDERER inside Deplo's
      // namespace, so they are enumerated from the YAML like any other stack
      // volume, but exempted from the guard that rejects a user-pinned one.
      composeStackVolumeHostNames(
        slug,
        composeYaml,
        namedVolumeHostNames(slug, project.volumes),
      )
    : namedVolumeHostNames(slug, project.volumes);
  // Fail fast with a clear message before any agent work, rather than letting the
  // agent reject a bad name opaquely after it starts streaming the archive.
  assertSafeVolumeNames(slug, volumeNames);

  return {
    slug,
    volumeNames,
    // Single-container apps keep their config files under the files dir only when they
    // have project-path mounts or `mounts`; a compose-stack project's `./` bind mounts
    // also land there.
    includeFiles: appHasFilesDir(project),
    composeYaml,
    envSnapshot: await appEnvSnapshot(project.id),
    mounts: (project.mounts ?? []).map((m) => ({
      path: m.filePath,
      content: m.content,
    })),
  };
}

/**
 * Whether a project could have a files dir (<stacks>/files/<slug>) worth
 * archiving: a compose-stack project (its `./x` bind mounts + template mounts live
 * there), any project with template `mounts`, or any with a `project`-type volume
 */
export function appHasFilesDir(project: App): boolean {
  if (usesComposeStack(project)) return true;
  if ((project.mounts ?? []).length > 0) return true;
  return (project.volumes ?? []).some((v) => v.type === "app");
}
