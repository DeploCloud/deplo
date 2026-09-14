"use client";

import { toast } from "sonner";

import {
  watchPathsToArray,
  type GitDeployOptionsValue,
} from "@/components/apps/git-deploy-options";
import type { GithubSelection } from "@/components/apps/github-repo-picker";
import type { GitSourceValue } from "@/components/apps/git-source-picker";
import type { DraftEnvRow } from "@/components/apps/wizard/env-draft-dialog";
import type { NameClash } from "@/components/apps/wizard/name-clash-dialog";
import {
  hasBlockingErrors,
  type LintDiagnostic,
} from "@/lib/deploy/compose-lint/lint";
import type { ComposeRouteCandidate } from "@/lib/deploy/compose-lint/routing";
import { uploadArchive } from "@/lib/deploy/upload-client";
import { buildConfigFor } from "@/lib/frameworks";
import { gqlAction } from "@/lib/graphql-client";
import type { useRouter } from "@/lib/nav";
import type { DeploySource } from "@/lib/types/app";
import type { BuildConfig } from "@/lib/types/build";
import { deploySourceEnumName } from "@/lib/types/app";

import type {
  CreateAppVariables,
  WizardPlacement,
  WizardTemplate,
} from "./types";
import { parseRepo } from "./source-hints";

// buildCreateAppInput - the wizard's answers as the `createApp` payload, or null once it has said why not.
export function buildCreateAppInput({
  name,
  serverId,
  buildServerId,
  source,
  isTemplate,
  template,
  useCompose,
  templateCompose,
  compose,
  composeDiags,
  composeUpArgs,
  composeArgsProblem,
  ghSelection,
  gitValue,
  dockerImage,
  gitOptions,
  buildsImage,
  build,
  envRows,
  sharedIds,
  usesGit,
  autoDeploy,
  shouldDeploy,
  primaryService,
  routeCandidates,
  extraRouted,
  placement,
}: {
  name: string;
  serverId: string;
  buildServerId: string | null;
  source: DeploySource | null;
  isTemplate: boolean;
  template?: WizardTemplate;
  useCompose: boolean;
  templateCompose: boolean;
  compose: string;
  composeDiags: LintDiagnostic[];
  composeUpArgs: string;
  composeArgsProblem: string | null;
  ghSelection: GithubSelection | null;
  gitValue: GitSourceValue;
  dockerImage: string;
  gitOptions: GitDeployOptionsValue;
  buildsImage: boolean;
  build: BuildConfig;
  envRows: DraftEnvRow[];
  sharedIds: string[];
  usesGit: boolean;
  autoDeploy: boolean;
  shouldDeploy: boolean;
  primaryService: ComposeRouteCandidate | null;
  routeCandidates: ComposeRouteCandidate[];
  extraRouted: string[];
  placement?: WizardPlacement | null;
}): CreateAppVariables | null {
  if (!name.trim()) {
    toast.error("Enter an app name");
    return null;
  }
  if (!serverId) {
    toast.error("Select a server to deploy to");
    return null;
  }
  if (useCompose && hasBlockingErrors(composeDiags)) {
    toast.error("Fix the compose errors before deploying");
    return null;
  }
  if (source === "compose" && !compose.trim()) {
    toast.error("Write a docker-compose stack to deploy");
    return null;
  }
  if (composeArgsProblem) {
    toast.error(composeArgsProblem);
    return null;
  }

  let repo = null as null | {
    provider: string;
    url: string;
    repo: string;
    branch: string;
    installationId?: string | null;
    connectionId?: string | null;
    triggerType?: "push" | "tag";
    watchPaths?: string[];
    submodules?: boolean;
  };
  let image: string | null = null;

  if (source === "github") {
    if (!ghSelection) {
      toast.error("Select a repository to deploy");
      return null;
    }
    repo = {
      provider: "github",
      url: `https://github.com/${ghSelection.fullName}`,
      repo: ghSelection.fullName,
      branch: ghSelection.branch || "main",
      installationId: ghSelection.installationId,
    };
  } else if (source === "git") {
    // A bare owner/repo still means GitHub, the way it always has; anything
    // else comes back from the picker already resolved.
    const parsed = parseRepo(gitValue.url);
    if (!parsed) {
      toast.error("Enter a valid Git repository URL");
      return null;
    }
    repo = {
      provider: gitValue.connectionId ? gitValue.provider : parsed.provider,
      url: gitValue.url.startsWith("http")
        ? gitValue.url
        : `https://github.com/${parsed.repo}`,
      repo: gitValue.connectionId ? gitValue.repo : parsed.repo,
      branch: gitValue.branch || "main",
      connectionId: gitValue.connectionId,
    };
  } else if (source === "docker-image") {
    if (!isTemplate && !dockerImage.trim()) {
      toast.error("Enter a Docker image reference");
      return null;
    }
    image = isTemplate ? null : dockerImage.trim();
  }

  if (repo) {
    repo = {
      ...repo,
      triggerType: gitOptions.triggerType,
      watchPaths: watchPathsToArray(gitOptions.watchPaths),
      submodules: gitOptions.submodules,
    };
  }

  const payloadBuild = buildsImage
    ? build
    : buildConfigFor({ buildMethod: "dockerfile" });
  const filledEnv = envRows.filter((e) => e.key.trim());

  return {
    name: name.trim(),
    // A template deploying its own stack is stored as the `compose`
    // source so settings opens on the Compose tab and the deploy engine
    // is unambiguous.
    source: deploySourceEnumName(useCompose ? "compose" : source!),
    serverId,
    buildServerId,
    composeUpArgs: useCompose ? composeUpArgs.trim() || null : null,
    dockerImage: image,
    // Seed the app's display logo from the template so a deployed
    // template carries its icon; editable later from app settings.
    logo: isTemplate ? template!.logo : null,
    logoFromTemplate: isTemplate,
    compose: useCompose ? compose : null,
    env: filledEnv.length
      ? filledEnv.map((e) => ({
          key: e.key.trim(),
          value: e.value,
          // Undefined lets the key's own name decide, which is what a
          // template's generated passwords want.
          type: e.secret ? "secret" : undefined,
        }))
      : undefined,
    sharedVarIds: sharedIds.length ? sharedIds : null,
    repo,
    build: {
      buildMethod: payloadBuild.buildMethod,
      settings: payloadBuild.methodSettings,
      installCommand: payloadBuild.installCommand,
      buildCommand: payloadBuild.buildCommand,
      outputDir: payloadBuild.outputDirectory,
      startCommand: payloadBuild.startCommand,
      rootDir: payloadBuild.rootDirectory,
      runtimeVersion: payloadBuild.runtimeVersion,
      port: payloadBuild.port,
    },
    autoDeploy: usesGit ? autoDeploy : false,
    deploy: shouldDeploy,
    // Where the first domain points: what a template declares, else what
    // the wizard showed the user for their own stack.
    composeService: templateCompose
      ? (template!.expose?.service ?? null)
      : (primaryService?.name ?? null),
    composePort: templateCompose
      ? (template!.expose?.port ?? null)
      : (primaryService?.port ?? null),
    extraDomains: templateCompose
      ? template!.exposes.slice(1).map((e) => ({
          service: e.service,
          port: e.port,
          host: e.host ?? null,
          path: e.path ?? null,
        }))
      : useCompose
        ? routeCandidates
            .filter((c) => extraRouted.includes(c.name))
            .map((c) => ({
              service: c.name,
              port: c.port,
              host: null,
              path: null,
            }))
        : null,
    autoDomain: templateCompose ? template!.autoDomain : null,
    autoDomainPath: templateCompose ? (template!.expose?.path ?? null) : null,
    mounts: templateCompose ? template!.mounts : null,
    folderId: placement?.folderId ?? null,
    projectId: placement?.projectId ?? null,
    environmentId: placement?.environmentId ?? null,
  };
}

// checkComposeNameClashes - ask before creating: a taken service name is a choice to make, not a refusal to read.
export function checkComposeNameClashes({
  compose,
  serverId,
  input,
}: {
  compose: string;
  serverId: string;
  input: CreateAppVariables;
}) {
  return gqlAction(
    /* GraphQL */ `
      query ($input: ComposeNameClashesInput!) {
        composeNameClashes(input: $input) {
          name
          owner
          renamedTo
        }
      }
    `,
    {
      input: {
        compose,
        serverId,
        folderId: input.folderId,
        projectId: input.projectId,
        environmentId: input.environmentId,
      },
    },
    (d: { composeNameClashes: NameClash[] }) => d.composeNameClashes,
  );
}

// submitCreatedApp - run `createApp`, land the held archive if there is one, then go where the result points.
export async function submitCreatedApp(
  input: CreateAppVariables,
  {
    router,
    source,
    uploadFile,
  }: {
    router: ReturnType<typeof useRouter>;
    source: DeploySource | null;
    uploadFile: File | null;
  },
) {
  const res = await gqlAction(
    /* GraphQL */ `
      mutation ($input: CreateAppInput!) {
        createApp(input: $input) {
          id
          slug
          latestDeployment {
            id
          }
        }
      }
    `,
    { input },
    (d: {
      createApp: {
        id: string;
        slug: string;
        latestDeployment: { id: string } | null;
      };
    }) => d.createApp,
  );
  if (!res.ok) {
    toast.error(res.error);
    return;
  }
  const app = res.data;
  if (!app) return;

  // Invalidate the router cache so the shared dashboard layout re-runs on
  // the destination, otherwise the topbar breadcrumb's team snapshot is
  // stale and the brand-new app is missing from it until a hard reload.
  router.refresh();

  if (source === "upload" && uploadFile) {
    try {
      await uploadArchive(app.id, uploadFile);
    } catch (e) {
      // The app exists but the archive didn't land - send the user to its
      // settings to retry rather than deploying nothing.
      toast.error(
        `App created, but the upload failed (${
          e instanceof Error ? e.message : "unknown error"
        }). Upload the archive from Settings.`,
      );
      router.push(`/apps/${app.slug}/settings`);
      return;
    }
    const dep = await gqlAction(
      `mutation($appId: String!) { redeploy(appId: $appId) { id } }`,
      { appId: app.id },
      (d: { redeploy: { id: string } }) => d.redeploy,
    );
    if (dep.ok && dep.data) {
      toast.success("Deployment started");
      router.push(`/apps/${app.slug}/deployments/${dep.data.id}`);
    } else {
      // The archive is stored; only the deploy kick-off failed.
      if (!dep.ok) toast.error(dep.error);
      router.push(`/apps/${app.slug}/settings`);
    }
    return;
  }

  const firstDeploymentId = app.latestDeployment?.id;
  toast.success(
    firstDeploymentId
      ? "Deployment started"
      : source === "upload"
        ? "App created - upload an archive from Settings to deploy"
        : "App created - it needs someone with permission to deploy",
  );
  router.push(
    firstDeploymentId
      ? `/apps/${app.slug}/deployments/${firstDeploymentId}`
      : `/apps/${app.slug}`,
  );
}
