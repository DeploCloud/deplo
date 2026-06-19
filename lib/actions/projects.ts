"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { run, type ActionResult } from "./result";
import {
  createProject,
  deleteProject,
  renameProject,
  setAutoDeploy,
  stopProject,
  startProject,
  rebuildProject,
  updateProjectBuild,
  updateProjectSource,
  updateProjectLogo,
} from "@/lib/data/projects";
import {
  redeploy,
  cancelDeployment,
  promoteToProduction,
} from "@/lib/data/deployments";
import { renderProjectStack } from "@/lib/deploy/build";
import { assertUser } from "@/lib/auth";
import type { FrameworkId } from "@/lib/types";
import { MAX_LOGO_STRING_LEN } from "@/lib/projects/logo-shared";

const FRAMEWORK_IDS = [
  "nextjs", "svelte", "sveltekit", "astro", "vite", "remix", "nuxt", "react",
  "vue", "angular", "gatsby", "static", "node", "python", "go", "rust", "php",
  "docker", "other",
] as const;

const DEPLOY_SOURCES = [
  "github",
  "git",
  "docker-image",
  "upload",
  "compose",
] as const;

const BUILD_METHODS = [
  "dockerfile",
  "railpack",
  "nixpacks",
  "heroku",
  "paketo",
  "static",
] as const;

const methodSettingsSchema = z
  .object({
    dockerfilePath: z.string().max(300).optional(),
    dockerContextPath: z.string().max(300).optional(),
    dockerBuildStage: z.string().max(120).optional(),
    railpackVersion: z.string().max(40).optional(),
    nixpacksPublishDirectory: z.string().max(300).optional(),
    herokuVersion: z.string().max(40).optional(),
    staticSinglePageApp: z.boolean().optional(),
  })
  .optional();

const repoSchema = z.object({
  provider: z.enum(["github", "gitlab", "bitbucket", "git"]),
  url: z.string().url(),
  repo: z.string().min(1),
  branch: z.string().min(1),
  installationId: z.string().min(1).nullable().optional(),
});

const exposeSchema = z.object({
  service: z.string().min(1).max(120),
  port: z.number().int().min(1).max(65535),
  host: z.string().max(253).optional(),
});
const exposesSchema = z.array(exposeSchema).max(20).nullable().optional();

const createSchema = z.object({
  name: z.string().min(1).max(64),
  framework: z.enum(FRAMEWORK_IDS),
  source: z.enum(DEPLOY_SOURCES),
  serverId: z.string().min(1).optional(),
  dockerImage: z.string().max(300).nullable().optional(),
  logo: z.string().max(MAX_LOGO_STRING_LEN).nullable().optional(),
  compose: z.string().max(50000).nullable().optional(),
  env: z
    .array(
      z.object({
        key: z.string().max(256),
        value: z.string().max(8000),
      })
    )
    .max(200)
    .optional(),
  repo: repoSchema.nullable(),
  build: z
    .object({
      buildMethod: z.enum(BUILD_METHODS).optional(),
      methodSettings: methodSettingsSchema,
      installCommand: z.string().max(500).optional(),
      buildCommand: z.string().max(500).optional(),
      outputDirectory: z.string().max(200).optional(),
      startCommand: z.string().max(500).optional(),
      rootDirectory: z.string().max(200).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      runtimeVersion: z.string().max(20).optional(),
    })
    .optional(),
  autoDeploy: z.boolean().optional(),
  composeService: z.string().max(120).nullable().optional(),
  composePort: z.number().int().min(1).max(65535).nullable().optional(),
  exposes: exposesSchema,
  autoDomain: z.string().max(253).nullable().optional(),
  mounts: z
    .array(
      z.object({
        filePath: z.string().min(1).max(256),
        content: z.string().max(100000),
      })
    )
    .max(20)
    .nullable()
    .optional(),
});

export async function createProjectAction(
  input: z.input<typeof createSchema>
): Promise<ActionResult<{ slug: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const res = await run(async () => {
    const project = await createProject({
      name: parsed.data.name,
      framework: parsed.data.framework as FrameworkId,
      source: parsed.data.source,
      serverId: parsed.data.serverId,
      dockerImage: parsed.data.dockerImage ?? null,
      logo: parsed.data.logo ?? null,
      compose: parsed.data.compose ?? null,
      env: parsed.data.env,
      repo: parsed.data.repo,
      build: parsed.data.build,
      autoDeploy: parsed.data.autoDeploy,
      composeService: parsed.data.composeService,
      composePort: parsed.data.composePort,
      exposes: parsed.data.exposes,
      autoDomain: parsed.data.autoDomain,
      mounts: parsed.data.mounts,
    });
    return { slug: project.slug };
  });
  if (res.ok) revalidatePath("/");
  return res;
}

/**
 * Render the full Deplo-generated compose stack (Traefik + deplo labels, the
 * injected network, absolute mount paths) for read-only display in settings.
 * Returns `null` data when there's nothing to show yet (e.g. a single-image
 * project that was never deployed). Read-only — auth-gated, no revalidation.
 */
export async function renderComposeStackAction(
  projectId: string,
): Promise<ActionResult<string | null>> {
  return run(async () => {
    await assertUser();
    return renderProjectStack(projectId);
  });
}

export async function redeployAction(projectId: string): Promise<ActionResult> {
  const res = await run(() => redeploy(projectId));
  if (res.ok) {
    revalidatePath("/");
    revalidatePath("/deployments");
  }
  return { ok: res.ok, error: res.ok ? undefined : res.error } as ActionResult;
}

export async function stopProjectAction(id: string): Promise<ActionResult> {
  const res = await run(() => stopProject(id));
  if (res.ok) {
    revalidatePath("/");
    revalidatePath("/projects");
  }
  return res as ActionResult;
}

export async function startProjectAction(id: string): Promise<ActionResult> {
  const res = await run(() => startProject(id));
  if (res.ok) {
    revalidatePath("/");
    revalidatePath("/projects");
  }
  return res as ActionResult;
}

export async function rebuildProjectAction(id: string): Promise<ActionResult> {
  const res = await run(() => rebuildProject(id));
  if (res.ok) {
    revalidatePath("/");
    revalidatePath("/deployments");
  }
  return res as ActionResult;
}

export async function cancelDeploymentAction(
  id: string
): Promise<ActionResult> {
  const res = await run(() => cancelDeployment(id));
  if (res.ok) revalidatePath("/deployments");
  return res as ActionResult;
}

export async function promoteAction(id: string): Promise<ActionResult> {
  const res = await run(() => promoteToProduction(id));
  if (res.ok) revalidatePath("/deployments");
  return res as ActionResult;
}

export async function setAutoDeployAction(
  id: string,
  value: boolean
): Promise<ActionResult> {
  const res = await run(() => setAutoDeploy(id, value));
  return res as ActionResult;
}

const buildSchema = z.object({
  framework: z.enum(FRAMEWORK_IDS).optional(),
  buildMethod: z.enum(BUILD_METHODS).optional(),
  methodSettings: methodSettingsSchema,
  installCommand: z.string().max(500).optional(),
  buildCommand: z.string().max(500).optional(),
  outputDirectory: z.string().max(200).optional(),
  startCommand: z.string().max(500).optional(),
  rootDirectory: z.string().max(200).optional(),
  runtimeVersion: z.string().max(20).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

export async function updateBuildAction(
  id: string,
  build: z.input<typeof buildSchema>
): Promise<ActionResult> {
  const parsed = buildSchema.safeParse(build);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  const res = await run(() =>
    updateProjectBuild(id, parsed.data as Parameters<typeof updateProjectBuild>[1])
  );
  if (res.ok) revalidatePath("/");
  return res as ActionResult;
}

const sourceSchema = z.object({
  source: z.enum(DEPLOY_SOURCES),
  serverId: z.string().min(1).optional(),
  dockerImage: z.string().max(300).nullable(),
  repo: repoSchema.nullable(),
  compose: z.string().max(50000).nullable().optional(),
  composeService: z.string().max(120).nullable().optional(),
  composePort: z.number().int().min(1).max(65535).nullable().optional(),
  exposes: exposesSchema,
});

export async function updateSourceAction(
  id: string,
  input: z.input<typeof sourceSchema>
): Promise<ActionResult> {
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const {
    source,
    serverId,
    dockerImage,
    repo,
    compose,
    composeService,
    composePort,
    exposes,
  } = parsed.data;
  if (source === "compose" && !compose?.trim())
    return { ok: false, error: "Compose file cannot be empty" };
  const res = await run(() =>
    updateProjectSource(id, {
      source,
      serverId,
      dockerImage,
      repo,
      // Only persist compose when the Compose source is active; switching to a
      // different source leaves the stored stack untouched (kept for switching
      // back), so we pass undefined rather than null there.
      compose: source === "compose" ? (compose ?? "") : undefined,
      expose:
        source === "compose" && composeService && composePort
          ? { service: composeService, port: composePort }
          : undefined,
      exposes: source === "compose" ? (exposes ?? null) : undefined,
    })
  );
  if (res.ok) revalidatePath("/");
  return res as ActionResult;
}


export async function renameProjectAction(
  id: string,
  name: string
): Promise<ActionResult> {
  if (!name.trim()) return { ok: false, error: "Name is required" };
  const res = await run(() => renameProject(id, name));
  if (res.ok) revalidatePath("/");
  return res as ActionResult;
}

const logoSchema = z.string().max(MAX_LOGO_STRING_LEN).nullable();

export async function updateLogoAction(
  id: string,
  logo: z.input<typeof logoSchema>
): Promise<ActionResult> {
  const parsed = logoSchema.safeParse(logo);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid logo" };
  const res = await run(() => updateProjectLogo(id, parsed.data));
  if (res.ok) {
    // Refresh both the dashboard cards (/) and the project header, which lives
    // in the [slug] layout that wraps the settings page the user is on.
    revalidatePath("/");
    revalidatePath("/(dashboard)/projects/[slug]", "layout");
  }
  return res as ActionResult;
}

export async function deleteProjectAction(
  id: string
): Promise<ActionResult> {
  const res = await run(() => deleteProject(id));
  if (!res.ok) return res;
  revalidatePath("/");
  redirect("/");
}
