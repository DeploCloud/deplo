import "server-only";

import yaml from "../yaml";

import { decryptSecretOrThrow } from "../crypto";
import { hostVolumeName, usesComposeStack } from "../utils";
import { composeOwnVolumeKeys } from "../deploy/compose-lint/volumes";
import { resolveEnvEntries } from "../deploy/env-resolve";
import { loadEnvVarsForApp } from "./app-graph-load";
import {
  loadAutoInjectedVarsForApp,
  loadSharedVarsForApp,
} from "./shared-vars/deploy-entries";
import { connectAgent } from "../infra/agent-client/connect";
import type { App } from "../types/app";
import type { VolumeMount } from "../types/container";

// What the agent's Backup/Restore RPC needs from a project.
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

// The exact decrypted env a project runs with in production.
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
    // Strict: a value that silently became "" would break the RESTORE, not the backup.
    out[e.key] = decryptSecretOrThrow(e.valueEnc, `The variable ${e.key}`);
  }
  return out;
}

// The on-host docker volume names for a SINGLE-CONTAINER project's named volumes.
export function namedVolumeHostNames(
  slug: string,
  volumes: VolumeMount[] | null | undefined,
): string[] {
  return (volumes ?? [])
    .filter((v) => (v.type ?? "named") === "named")
    .map((v) => hostVolumeName(slug, v.name));
}

// Deplo owns the `deplo-` host-volume namespace: every per-app volume it derives lives there.
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
    if (typeof s.name === "string" && s.name) {
      assertNotReservedVolumeName(slug, s.name, own);
      names.push(s.name);
      continue;
    }
    // `external` is `true`, or the deprecated long form: an object that may carry a `name`.
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
    // Compose names an unnamed volume `<project>_<key>`, and the project is `deplo-<slug>`.
    names.push(`deplo-${slug}_${key}`);
  }
  return names;
}

// MIRRORS the agent's `volumeNamePattern` (deplo-agent backup_tar.go).
const AGENT_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// Validate every resolved host volume name against the agent's rule.
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

// The on-host docker volume names to COPY on an app server MOVE.
export function appMoveVolumeNames(
  project: App,
  renderedYaml: string,
): string[] {
  const slug = project.slug;
  if (!usesComposeStack(project)) {
    return namedVolumeHostNames(slug, project.volumes);
  }
  let doc: unknown;
  try {
    doc = yaml.load(renderedYaml);
  } catch {
    return [];
  }
  const volumes = (doc as { volumes?: unknown } | null)?.volumes;
  if (!volumes || typeof volumes !== "object") return [];
  // Deplo pins the app's Storage volumes itself: they must not trip the reserved-name guard.
  const own = new Set(namedVolumeHostNames(slug, project.volumes));
  const names: string[] = [];
  for (const [key, spec] of Object.entries(
    volumes as Record<string, unknown>,
  )) {
    const s = (spec ?? {}) as { name?: unknown; external?: unknown };
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

// Every host volume this app owns BY NAME - what a teardown reclaims.
export function appOwnVolumeNames(project: App): string[] {
  return [
    ...namedVolumeHostNames(project.slug, project.volumes),
    ...composeOwnVolumeKeys(project.compose ?? "").map(
      (key) => `deplo-${project.slug}_${key}`,
    ),
  ];
}

// What a move leaves on the old host ON PURPOSE: host paths and `external:` volumes.
export function appMoveLeftBehind(
  project: App,
  renderedYaml: string,
): string[] {
  const out = (project.volumes ?? [])
    .filter((v) => v.type === "host" && v.hostPath)
    .map((v) => `host path ${v.hostPath}`);
  let doc: unknown;
  try {
    doc = yaml.load(renderedYaml);
  } catch {
    return out;
  }
  const volumes = (doc as { volumes?: unknown } | null)?.volumes;
  if (!volumes || typeof volumes !== "object") return out;
  for (const [key, spec] of Object.entries(
    volumes as Record<string, unknown>,
  )) {
    const s = (spec ?? {}) as { name?: unknown; external?: unknown };
    if (!s.external) continue;
    const ext = s.external as { name?: unknown };
    const name =
      typeof s.name === "string" && s.name
        ? s.name
        : typeof ext === "object" && typeof ext.name === "string" && ext.name
          ? ext.name
          : key;
    out.push(`external volume ${name}`);
  }
  return out;
}

// Build the full backup descriptor for a project.
export async function buildProjectDescriptor(
  project: App,
): Promise<ProjectBackupDescriptor> {
  const slug = project.slug;
  const composeStack = usesComposeStack(project);

  const conn = await connectAgent(project.serverId);
  let stack: { exists: boolean; yaml: string };
  try {
    stack = await conn.readStack(slug);
  } finally {
    conn.close();
  }

  const composeYaml = stack.exists ? stack.yaml : "";
  const volumeNames = composeStack
    ? // Deplo's RENDERER pins the app's Storage volumes, exempt from the reserved-name guard.
      composeStackVolumeHostNames(
        slug,
        composeYaml,
        namedVolumeHostNames(slug, project.volumes),
      )
    : namedVolumeHostNames(slug, project.volumes);
  assertSafeVolumeNames(slug, volumeNames);

  return {
    slug,
    volumeNames,
    includeFiles: appHasFilesDir(project),
    composeYaml,
    envSnapshot: await appEnvSnapshot(project.id),
    mounts: (project.mounts ?? []).map((m) => ({
      path: m.filePath,
      content: m.content,
    })),
  };
}

// Whether a project could have a files dir (<stacks>/files/<slug>) worth archiving.
export function appHasFilesDir(project: App): boolean {
  if (usesComposeStack(project)) return true;
  if ((project.mounts ?? []).length > 0) return true;
  return (project.volumes ?? []).some((v) => v.type === "app");
}
