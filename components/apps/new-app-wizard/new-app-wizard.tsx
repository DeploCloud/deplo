"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { useUrlStep } from "@/lib/wizard-step";
import { toast } from "sonner";
import { Server as ServerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";

import type { GithubSelection } from "@/components/apps/github-repo-picker";
import type { GitSourceValue } from "@/components/apps/git-source-picker";
import {
  DEFAULT_GIT_DEPLOY_OPTIONS,
  type GitDeployOptionsValue,
} from "@/components/apps/git-deploy-options";
import { ArchiveDropZone } from "@/components/apps/archive-drop-zone";
import {
  WizardCard,
  WizardStage,
  useStepSwap,
} from "@/components/apps/wizard/wizard-card";
import { SourceTiles } from "@/components/apps/wizard/source-tiles";
import { templatesHref } from "@/lib/overview-links";
import { ComposeDialog } from "@/components/apps/wizard/compose-dialog";
import {
  EnvDraftDialog,
  type DraftEnvRow,
  type LinkableSharedVar,
} from "@/components/apps/wizard/env-draft-dialog";
import {
  NameClashDialog,
  type NameClash,
} from "@/components/apps/wizard/name-clash-dialog";

import {
  lintCompose,
  type LintDiagnostic,
} from "@/lib/deploy/compose-lint/lint";
import {
  composeServiceNames,
  composeRouteCandidates,
} from "@/lib/deploy/compose-lint/routing";
import { validateComposeUpArgs } from "@/lib/deploy/compose-args";
import {
  clearPendingArchive,
  peekPendingArchive,
} from "@/lib/deploy/pending-archive";
import type { DeploySource } from "@/lib/types/app";
import type { GitProviderChoice } from "@/lib/types/git";
import type { GitConnectionDTO } from "@/lib/data/git-connections";
import type { GithubInstallationDTO } from "@/lib/data/github";

import { buildConfigFor } from "@/lib/frameworks";

import { WizardAdvanced } from "./advanced-fields";
import {
  CloneFields,
  cloneTargetReady,
  type CloneTarget,
} from "./clone-fields";
import { ConfigureStep } from "./configure-step";
import {
  buildCreateAppInput,
  checkComposeNameClashes,
  cloneProject,
  submitCreatedApp,
  type ClonedRepo,
} from "./create-app";
import { AppNameField, DetailsStep } from "./details-step";
import { SourceFields } from "./source-fields";
import {
  nameFromArchive,
  nameFromRepo,
  parseRepo,
  templateTitle,
} from "./source-hints";
import { useBuildConfig } from "./use-build-config";
import type {
  CreateAppVariables,
  Step,
  WizardBuildServer,
  WizardClone,
  WizardPlacement,
  WizardServer,
  WizardTemplate,
} from "./types";

export function NewAppWizard({
  servers,
  buildServers,
  sharedVars,
  template,
  clone,
  presetRepo,
  presetBranch,
  presetInstallationId,
  presetConnectionId,
  presetName,
  presetSource,
  installations,
  connections,
  providers,
  isInstanceAdmin,
  placement,
  exitHref,
  backHref,
}: {
  servers: WizardServer[];
  buildServers: WizardBuildServer[];
  sharedVars: LinkableSharedVar[];
  template?: WizardTemplate;
  clone?: WizardClone;
  presetRepo?: string;
  presetBranch?: string;
  presetInstallationId?: string;
  presetConnectionId?: string;
  presetName?: string;
  presetSource?: DeploySource | null;
  installations: GithubInstallationDTO[];
  connections: GitConnectionDTO[];
  providers: GitProviderChoice[];
  isInstanceAdmin: boolean;
  placement?: WizardPlacement | null;
  exitHref: string;
  /** Where Back leads from the first step, when the wizard was opened from a list. */
  backHref?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const isTemplate = Boolean(template);

  const [dropped] = React.useState(peekPendingArchive);
  React.useEffect(() => clearPendingArchive(), []);

  const presetGithub =
    presetRepo && installations.some((i) => i.id === presetInstallationId)
      ? presetInstallationId
      : null;
  const presetConnection =
    (presetRepo && connections.find((c) => c.id === presetConnectionId)) ||
    null;
  const [source, setSource] = React.useState<DeploySource | null>(
    clone
      ? "git"
      : isTemplate
        ? "docker-image"
        : dropped
          ? "upload"
          : (presetSource ??
            (presetGithub ? "github" : presetRepo ? "git" : null)),
  );
  const firstStep: Step =
    clone || isTemplate || presetSource || presetRepo || dropped
      ? "details"
      : "source";
  const url = useUrlStep<Step>(firstStep);
  const { step, direction, leaving, go } = useStepSwap(firstStep, url);

  const ghPreset: GithubSelection | null =
    presetGithub && presetRepo
      ? {
          installationId: presetGithub,
          fullName: presetRepo,
          branch: presetBranch || "main",
        }
      : null;
  const [ghSelection, setGhSelection] = React.useState(ghPreset);
  const [gitValue, setGitValue] = React.useState<GitSourceValue>(
    presetConnection && presetRepo
      ? {
          provider: presetConnection.provider,
          url: `${presetConnection.baseUrl.replace(/\/+$/, "")}/${presetRepo}`,
          repo: presetRepo,
          branch: presetBranch || "main",
          connectionId: presetConnection.id,
        }
      : {
          provider: presetRepo ? "github" : "git",
          url: presetRepo ? `https://github.com/${presetRepo}` : "",
          repo: presetRepo ?? "",
          branch: presetBranch || "main",
          connectionId: null,
        },
  );
  const [dockerImage, setDockerImage] = React.useState("");
  const [uploadFile, setUploadFile] = React.useState<File | null>(dropped);
  const [compose, setCompose] = React.useState(template?.compose ?? "");
  const [composeDiags, setComposeDiags] = React.useState<LintDiagnostic[]>(
    () => (template?.compose ? lintCompose(template.compose) : []),
  );
  const [extraRouted, setExtraRouted] = React.useState<string[]>([]);
  const [cloneTarget, setCloneTarget] = React.useState<CloneTarget>(() => ({
    destinationKey:
      (clone?.destinations.find((d) => !d.needs) ?? clone?.destinations[0])
        ?.key ?? "",
    repoName: clone?.suggestedName ?? "",
    private: true,
  }));
  const [cloned, setCloned] = React.useState<ClonedRepo | null>(null);

  const [name, setName] = React.useState(
    presetName ??
      (clone ? nameFromRepo(clone.fullName) : undefined) ??
      template?.name ??
      (dropped ? nameFromArchive(dropped.name) : ""),
  );
  const [nameTouched, setNameTouched] = React.useState(
    Boolean(presetName ?? template?.name),
  );
  const [serverId, setServerId] = React.useState(servers[0]?.id ?? "");
  const clusterIds = React.useMemo(
    () => servers.filter((s) => s.kind === "cluster").map((s) => s.id),
    [servers],
  );
  const [buildServerId, setBuildServerId] = React.useState<string | null>(null);
  const [autoDeploy, setAutoDeploy] = React.useState(true);
  const [gitOptions, setGitOptions] = React.useState<GitDeployOptionsValue>(
    DEFAULT_GIT_DEPLOY_OPTIONS,
  );
  const [composeUpArgs, setComposeUpArgs] = React.useState("");
  const [envRows, setEnvRows] = React.useState<DraftEnvRow[]>(
    template?.env ?? [],
  );
  const [sharedIds, setSharedIds] = React.useState<string[]>([]);
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [envOpen, setEnvOpen] = React.useState(false);
  const [clash, setClash] = React.useState<{
    input: CreateAppVariables;
    clashes: NameClash[];
  } | null>(null);

  const usesGit = source === "github" || source === "git";
  const buildsImage = source !== "docker-image" && source !== "compose";
  const templateCompose = isTemplate && source === "docker-image";
  const useCompose = templateCompose || source === "compose";

  const {
    build,
    onBuildChange,
    framework,
    detectingFramework,
    prefilledBuild,
    prefilledStart,
    setImagePort,
  } = useBuildConfig({
    source,
    buildsImage,
    ghSelection,
    gitValue,
    // A Deploy button's project builds with Railpack, or with the compose file its link names.
    initial: clone
      ? clone.composeFile
        ? buildConfigFor({
            buildMethod: "compose",
            methodSettings: { composeFile: clone.composeFile },
          })
        : buildConfigFor({ buildMethod: "railpack" })
      : undefined,
  });

  function suggestName(suggested: string) {
    if (!nameTouched && suggested) setName(suggested);
  }

  function onGitChange(value: GitSourceValue) {
    setGitValue(value);
    if (value.repo) suggestName(nameFromRepo(value.repo));
  }

  function onComposeSaved(next: string, diagnostics: LintDiagnostic[]) {
    setCompose(next);
    setComposeDiags(diagnostics);
    setExtraRouted([]);
    suggestName(composeServiceNames(next)[0] ?? "");
  }

  const composeServices = React.useMemo(
    () => (compose.trim() ? composeServiceNames(compose) : []),
    [compose],
  );
  const routeCandidates = React.useMemo(
    () =>
      compose.trim() && !isTemplate ? composeRouteCandidates(compose) : [],
    [compose, isTemplate],
  );
  const primaryService = routeCandidates.find((c) => c.isPrimary) ?? null;
  const composeArgsProblem = composeUpArgs.trim()
    ? validateComposeUpArgs(composeUpArgs.trim())
    : null;

  function sourceReady(): boolean {
    if (clone) return Boolean(cloned) || cloneTargetReady(clone, cloneTarget);
    if (source === "github") return Boolean(ghSelection);
    if (source === "git") return Boolean(parseRepo(gitValue.url));
    if (source === "docker-image")
      return isTemplate || Boolean(dockerImage.trim());
    if (source === "upload") return Boolean(uploadFile);
    if (source === "compose") return Boolean(compose.trim());
    return false;
  }

  url.settle(
    clone
      ? ["details", "configure"]
      : isTemplate
        ? ["details"]
        : ["source", "details", ...(usesGit ? (["configure"] as Step[]) : [])],
    (s) =>
      s === "source" || (source !== null && (s === "details" || sourceReady())),
  );

  const nextDisabled =
    step === "details"
      ? !sourceReady() || (!usesGit && !name.trim())
      : !name.trim();

  function onBack() {
    if (isTemplate || ((clone || backHref) && step === "details")) {
      router.push(backHref ?? exitHref);
      return;
    }
    go(step === "configure" ? "details" : "source", "back");
  }

  function onNext() {
    if (step === "details" && usesGit) {
      go("configure", "forward");
      return;
    }
    deploy();
  }

  function deploy(startDeployment = true) {
    if (clone) {
      deployClone(startDeployment);
      return;
    }
    const input = buildCreateAppInput({
      name,
      serverId,
      clusterIds,
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
      shouldDeploy: startDeployment,
      primaryService,
      routeCandidates,
      extraRouted,
      placement,
    });
    if (!input) return;

    startTransition(async () => {
      if (useCompose && !clusterIds.includes(serverId)) {
        const pre = await checkComposeNameClashes({ compose, serverId, input });
        if (!pre.ok) {
          toast.error(pre.error);
          return;
        }
        if (pre.data && pre.data.length > 0) {
          setClash({ input, clashes: pre.data });
          return;
        }
      }
      await submitCreatedApp(input, { router, source, uploadFile });
    });
  }

  // Copy the project once, then create the app from the new repository like any other.
  function deployClone(startDeployment: boolean) {
    if (!clone) return;
    startTransition(async () => {
      let repo = cloned;
      if (!repo) {
        const dest = clone.destinations.find(
          (d) => d.key === cloneTarget.destinationKey,
        );
        if (!dest) {
          toast.error("Choose a Git account for the new repository");
          return;
        }
        const res = await cloneProject(clone, dest, cloneTarget);
        if (!res.ok || !res.data) {
          if (!res.ok) toast.error(res.error);
          return;
        }
        repo = res.data;
        setCloned(repo);
      }
      const isGithub = repo.provider === "github";
      const input = buildCreateAppInput({
        name,
        serverId,
        clusterIds,
        buildServerId,
        source: isGithub ? "github" : "git",
        isTemplate: false,
        useCompose: false,
        templateCompose: false,
        compose: "",
        composeDiags: [],
        composeUpArgs: "",
        composeArgsProblem: null,
        ghSelection: isGithub
          ? {
              installationId: repo.installationId!,
              fullName: repo.fullName,
              branch: repo.branch,
            }
          : null,
        gitValue: {
          provider: repo.provider as GitSourceValue["provider"],
          url: repo.url,
          repo: repo.fullName,
          branch: repo.branch,
          connectionId: repo.connectionId,
        },
        dockerImage: "",
        gitOptions,
        buildsImage: true,
        build: {
          ...build,
          startCommand: build.startCommand || repo.startCommand,
          // 3000 is the untouched default; a port someone typed stays.
          port: repo.port && build.port === 3000 ? repo.port : build.port,
        },
        envRows,
        sharedIds,
        usesGit: true,
        autoDeploy,
        shouldDeploy: startDeployment,
        primaryService: null,
        routeCandidates: [],
        extraRouted: [],
        placement,
      });
      if (!input) return;
      await submitCreatedApp(input, {
        router,
        source: isGithub ? "github" : "git",
        uploadFile: null,
      });
    });
  }

  const meta = placement ? <PlacementMeta label={placement.label} /> : null;

  const advanced = (
    <WizardAdvanced
      servers={servers}
      serverId={serverId}
      setServerId={setServerId}
      buildServers={buildServers}
      buildServerId={buildServerId}
      setBuildServerId={setBuildServerId}
      envRows={envRows}
      sharedIds={sharedIds}
      onEditEnv={() => setEnvOpen(true)}
      source={source}
      useCompose={useCompose}
      templateCompose={templateCompose && !template?.imported}
      buildsImage={buildsImage}
      usesGit={usesGit}
      build={build}
      onBuildChange={onBuildChange}
      gitOptions={gitOptions}
      setGitOptions={setGitOptions}
      composeServices={composeServices}
      composeDiags={composeDiags}
      onOpenCompose={() => setComposeOpen(true)}
      composeUpArgs={composeUpArgs}
      setComposeUpArgs={setComposeUpArgs}
      composeArgsProblem={composeArgsProblem}
    />
  );

  const nameField = (
    <AppNameField
      value={name}
      onChange={(next) => {
        setName(next);
        setNameTouched(true);
      }}
    />
  );

  const noServer = servers.length === 0 && (
    <EmptyState
      icon={ServerIcon}
      title="No server connected"
      docs="servers.add"
      description="Deplo runs your apps on a server, and none is connected yet."
      action={
        <Button asChild>
          <Link href="/settings/servers">Add a server</Link>
        </Button>
      }
    />
  );

  return (
    <>
      <ArchiveDropZone
        onFile={(file) => {
          setUploadFile(file);
          setSource("upload");
          suggestName(nameFromArchive(file.name));
          if (step === "source") go("details", "forward");
        }}
      />

      <WizardStage step={step} direction={direction} leaving={leaving}>
        {step === "source" ? (
          <SourceStep
            meta={meta}
            value={source}
            onSelect={(next) => {
              setSource(next);
              go("details", "forward");
            }}
            templatesHref={templatesHref(placement)}
          />
        ) : step === "details" ? (
          <DetailsStep
            heading={
              clone
                ? {
                    title: "New app",
                    description:
                      "Deplo copies this project into your Git account, then puts it online.",
                  }
                : undefined
            }
            isTemplate={isTemplate}
            template={template}
            source={source}
            meta={meta}
            onBack={onBack}
            onNext={onNext}
            usesGit={usesGit}
            onCreateWithoutDeploy={isTemplate ? () => deploy(false) : undefined}
            nextDisabled={nextDisabled}
            pending={pending}
            sourceFields={
              clone ? (
                <CloneFields
                  clone={clone}
                  target={cloneTarget}
                  onChange={setCloneTarget}
                  locked={Boolean(cloned)}
                />
              ) : (
                <SourceFields
                  source={source}
                  isTemplate={isTemplate}
                  installations={installations}
                  setSource={setSource}
                  ghPreset={ghPreset}
                  setGhSelection={setGhSelection}
                  suggestName={suggestName}
                  connections={connections}
                  providers={providers}
                  isInstanceAdmin={isInstanceAdmin}
                  gitValue={gitValue}
                  onGitChange={onGitChange}
                  dockerImage={dockerImage}
                  setDockerImage={setDockerImage}
                  setImagePort={setImagePort}
                  uploadFile={uploadFile}
                  setUploadFile={setUploadFile}
                />
              )
            }
            useCompose={useCompose}
            composeServices={composeServices}
            composeDiags={composeDiags}
            onOpenCompose={() => setComposeOpen(true)}
            routeCandidates={routeCandidates}
            extraRouted={extraRouted}
            setExtraRouted={setExtraRouted}
            nameField={nameField}
            noServer={noServer}
            hasServers={servers.length > 0}
            advanced={advanced}
          />
        ) : (
          <ConfigureStep
            meta={meta}
            onBack={onBack}
            onNext={onNext}
            nextDisabled={nextDisabled}
            pending={pending}
            nameField={nameField}
            detectingFramework={detectingFramework}
            framework={framework}
            build={build}
            onBuildChange={onBuildChange}
            prefilledBuild={prefilledBuild}
            prefilledStart={prefilledStart}
            source={source}
            ghSelection={ghSelection}
            gitValue={gitValue}
            autoDeploy={autoDeploy}
            setAutoDeploy={setAutoDeploy}
            noServer={noServer}
            hasServers={servers.length > 0}
            advanced={advanced}
          />
        )}
      </WizardStage>

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        value={compose}
        onSave={onComposeSaved}
        title={isTemplate ? templateTitle(template!) : "Docker Compose"}
      />
      <NameClashDialog
        clashes={clash?.clashes ?? []}
        open={clash !== null}
        onOpenChange={(o) => !o && setClash(null)}
        pending={pending}
        onRename={() => {
          const held = clash;
          if (!held) return;
          startTransition(async () => {
            await submitCreatedApp(
              { ...held.input, renameClashes: true },
              { router, source, uploadFile },
            );
            setClash(null);
          });
        }}
      />
      <EnvDraftDialog
        open={envOpen}
        onOpenChange={setEnvOpen}
        rows={envRows}
        sharedIds={sharedIds}
        sharedVars={sharedVars}
        onSave={(rows, ids) => {
          setEnvRows(rows);
          setSharedIds(ids);
        }}
      />
    </>
  );
}

export function SourceStep({
  meta,
  value,
  onSelect,
  templatesHref,
}: {
  meta: React.ReactNode;
  value: DeploySource | null;
  onSelect: (source: DeploySource) => void;
  templatesHref: string;
}) {
  return (
    <WizardCard
      title="New app"
      description="Where does your code live? Deplo takes it from there and puts it online."
      meta={meta}
    >
      <SourceTiles
        value={value}
        onSelect={onSelect}
        templatesHref={templatesHref}
      />
    </WizardCard>
  );
}

export function PlacementMeta({ label }: { label: React.ReactNode }) {
  return (
    <p className="text-xs text-muted-foreground">
      Creating in <span className="text-foreground">{label}</span>
    </p>
  );
}
