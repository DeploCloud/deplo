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

export interface ProjectBackupDescriptor {
  slug: string;
  volumeNames: string[];
  includeFiles: boolean;
  composeYaml: string;
  envSnapshot: Record<string, string>;
  mounts: { path: string; content: string }[];
}

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
    out[e.key] = decryptSecretOrThrow(e.valueEnc, `The variable ${e.key}`);
  }
  return out;
}

export function namedVolumeHostNames(
  slug: string,
  volumes: VolumeMount[] | null | undefined,
): string[] {
  return (volumes ?? [])
    .filter((v) => (v.type ?? "named") === "named")
    .map((v) => hostVolumeName(slug, v.name));
}

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
    names.push(`deplo-${slug}_${key}`);
  }
  return names;
}

const AGENT_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

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

export function appOwnVolumeNames(project: App): string[] {
  return [
    ...namedVolumeHostNames(project.slug, project.volumes),
    ...composeOwnVolumeKeys(project.compose ?? "").map(
      (key) => `deplo-${project.slug}_${key}`,
    ),
  ];
}

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
    ? composeStackVolumeHostNames(
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

export function appHasFilesDir(project: App): boolean {
  if (usesComposeStack(project)) return true;
  if ((project.mounts ?? []).length > 0) return true;
  return (project.volumes ?? []).some((v) => v.type === "app");
}
