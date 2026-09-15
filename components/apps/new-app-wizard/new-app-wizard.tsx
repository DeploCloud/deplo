"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Server as ServerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";

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

import { WizardAdvanced } from "./advanced-fields";
import { ConfigureStep } from "./configure-step";
import {
  buildCreateAppInput,
  checkComposeNameClashes,
  submitCreatedApp,
} from "./create-app";
import { DetailsStep } from "./details-step";
import { SourceFields } from "./source-fields";
import { nameFromArchive, parseRepo, templateTitle } from "./source-hints";
import { useBuildConfig } from "./use-build-config";
import type {
  CreateAppVariables,
  Step,
  WizardBuildServer,
  WizardPlacement,
  WizardServer,
  WizardTemplate,
} from "./types";

export function NewAppWizard({
  servers,
  buildServers,
  sharedVars,
  template,
  presetRepo,
  presetName,
  presetSource,
  installations,
  connections,
  providers,
  isInstanceAdmin,
  shouldDeploy = true,
  placement,
  exitHref,
}: {
  servers: WizardServer[];
  buildServers: WizardBuildServer[];
  sharedVars: LinkableSharedVar[];
  template?: WizardTemplate;
  presetRepo?: string;
  presetName?: string;
  presetSource?: DeploySource | null;
  installations: GithubInstallationDTO[];
  connections: GitConnectionDTO[];
  providers: GitProviderChoice[];
  isInstanceAdmin: boolean;
  shouldDeploy?: boolean;
  placement?: WizardPlacement | null;
  exitHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const isTemplate = Boolean(template);

  const [dropped] = React.useState(peekPendingArchive);
  React.useEffect(() => clearPendingArchive(), []);

  const [source, setSource] = React.useState<DeploySource | null>(
    isTemplate
      ? "docker-image"
      : dropped
        ? "upload"
        : (presetSource ?? (presetRepo ? "git" : null)),
  );
  const { step, direction, leaving, go } = useStepSwap<Step>(
    isTemplate || presetSource || presetRepo || dropped ? "details" : "source",
  );

  const [ghSelection, setGhSelection] = React.useState<GithubSelection | null>(
    null,
  );
  const [gitValue, setGitValue] = React.useState<GitSourceValue>({
    provider: presetRepo ? "github" : "git",
    url: presetRepo ? `https://github.com/${presetRepo}` : "",
    repo: presetRepo ?? "",
    branch: "main",
    connectionId: null,
  });
  const [dockerImage, setDockerImage] = React.useState("");
  const [uploadFile, setUploadFile] = React.useState<File | null>(dropped);
  const [compose, setCompose] = React.useState(template?.compose ?? "");
  const [composeDiags, setComposeDiags] = React.useState<LintDiagnostic[]>(
    () => (template?.compose ? lintCompose(template.compose) : []),
  );
  const [extraRouted, setExtraRouted] = React.useState<string[]>([]);

  const [name, setName] = React.useState(
    presetName ??
      template?.name ??
      (dropped ? nameFromArchive(dropped.name) : ""),
  );
  const [nameTouched, setNameTouched] = React.useState(
    Boolean(presetName ?? template?.name),
  );
  const [serverId, setServerId] = React.useState(servers[0]?.id ?? "");
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
  } = useBuildConfig({ source, buildsImage, ghSelection, gitValue });

  function suggestName(suggested: string) {
    if (!nameTouched && suggested) setName(suggested);
  }

  function onGitChange(value: GitSourceValue) {
    setGitValue(value);
    if (value.repo) suggestName(value.repo.split("/").pop() ?? "");
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
    if (source === "github") return Boolean(ghSelection);
    if (source === "git") return Boolean(parseRepo(gitValue.url));
    if (source === "docker-image")
      return isTemplate || Boolean(dockerImage.trim());
    if (source === "upload") return Boolean(uploadFile);
    if (source === "compose") return Boolean(compose.trim());
    return false;
  }

  const nextDisabled =
    step === "details"
      ? !sourceReady() || (!usesGit && !name.trim())
      : !name.trim();

  function onBack() {
    if (isTemplate) {
      router.push(exitHref);
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

  function deploy() {
    const input = buildCreateAppInput({
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
    });
    if (!input) return;

    startTransition(async () => {
      if (useCompose) {
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

  const meta = placement ? (
    <p className="text-xs text-muted-foreground">
      Creating in <span className="text-foreground">{placement.label}</span>
    </p>
  ) : null;

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
      templateCompose={templateCompose}
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
    <div className="space-y-2">
      <FieldLabel
        htmlFor="name"
        info="Shown everywhere in Deplo. It also seeds the app's URL, which is frozen after creation."
      >
        App name
      </FieldLabel>
      <Input
        id="name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setNameTouched(true);
        }}
        placeholder="my-app"
      />
    </div>
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
          <WizardCard
            title="New app"
            description="Where does your code live? Deplo takes it from there and puts it online."
            meta={meta}
          >
            <SourceTiles
              value={source}
              onSelect={(next) => {
                setSource(next);
                go("details", "forward");
              }}
              templatesHref={templatesHref(placement)}
            />
          </WizardCard>
        ) : step === "details" ? (
          <DetailsStep
            isTemplate={isTemplate}
            template={template}
            source={source}
            meta={meta}
            onBack={onBack}
            onNext={onNext}
            usesGit={usesGit}
            shouldDeploy={shouldDeploy}
            nextDisabled={nextDisabled}
            pending={pending}
            sourceFields={
              <SourceFields
                source={source}
                isTemplate={isTemplate}
                installations={installations}
                setSource={setSource}
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
            shouldDeploy={shouldDeploy}
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
