"use client";

import { Save, FileText, Rocket } from "lucide-react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import {
  Tabs,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { ComposeEditor } from "@/components/apps/compose-editor";
import { ComposeLintSummary } from "@/components/apps/compose-lint-summary";
import { FullComposeDialog } from "@/components/apps/full-compose-dialog";
import { ImageInput } from "@/components/apps/image-input";
import { GithubRepoPicker } from "@/components/apps/github-repo-picker";
import { GitSourcePicker } from "@/components/apps/git-source-picker";
import { UploadInput } from "@/components/apps/upload-input";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { CopyButton } from "@/components/shared/copy-button";
import { GitAccessNotice } from "@/components/shared/git-access-notice";
import type { DeploySource } from "@/lib/types/app";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { SOURCE_TABS } from "@/components/apps/source-tabs";
import { AdditionalOptionsDrawer } from "./additional-options-drawer";
import type {
  DeploymentSettings,
  DeploymentSettingsProps,
} from "./use-deployment-settings";

// DeploySourceCard: how the app is deployed, which server runs it, and its Save.
export function DeploySourceCard({
  settings,
  appId,
  source: initialSource,
  repo: initialRepo,
  upload: initialUpload,
  servers,
  neighbours,
  installations,
  connections,
  providers,
  isInstanceAdmin,
  webhook,
  repoAccess,
  cloneRefusal,
  connectionAccess,
  canManageGit,
}: DeploymentSettingsProps & { settings: DeploymentSettings }) {
  const {
    source,
    setSource,
    usesGithubApp,
    usesGitUrl,
    sourceDirty,
    setGhSelection,
    setGitValue,
    dockerImage,
    setDockerImage,
    compose,
    setCompose,
    composeDiags,
    setComposeDiags,
    deploySourceCardDirty,
    pending,
    saveSource,
    saveAndDeploy,
  } = settings;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Deploy Source
          <InfoTip
            content="Change how this app is deployed and which server runs it."
            docs="build.settings"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The page sub-nav's own tab strip, inside the card: no panels, the
            conditional inputs below render off the `source` state. */}
        <Tabs
          value={source}
          onValueChange={(v) => setSource(v as DeploySource)}
        >
          <UnderlineTabsList>
            {SOURCE_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <UnderlineTabsTrigger key={tab.id} value={tab.id}>
                  <Icon className="size-4" />
                  {tab.label}
                </UnderlineTabsTrigger>
              );
            })}
          </UnderlineTabsList>
        </Tabs>

        {/* The tabs swap whole blocks, so the card's height jumps. */}
        <AnimatedHeight className="space-y-4" scroll={false}>
          {usesGithubApp && (
            // Always render the picker - it owns the account switcher (with a
            // Manage-connected-apps affordance) and its own connect empty state,
            // so the layout stays put whether or not an App is connected yet.
            <GithubRepoPicker
              installations={installations}
              manageHref="/settings/git"
              onUsePublicUrl={() => setSource("git")}
              initial={
                initialSource === "github" && initialRepo
                  ? {
                      installationId: initialRepo.installationId,
                      fullName: initialRepo.repo,
                      branch: initialRepo.branch,
                    }
                  : undefined
              }
              onChange={setGhSelection}
            />
          )}

          {usesGitUrl && (
            <GitSourcePicker
              connections={connections}
              providers={providers}
              isInstanceAdmin={isInstanceAdmin}
              initial={
                initialSource === "git" && initialRepo
                  ? {
                      connectionId: initialRepo.connectionId,
                      url: initialRepo.url,
                      repo: initialRepo.repo,
                      branch: initialRepo.branch,
                    }
                  : undefined
              }
              onChange={setGitValue}
            />
          )}

          {/* Both describe the SAVED source, so they step aside while another tab
              is open, or while the picker holds an edit Save has yet to re-check. */}
          {usesGithubApp &&
            !sourceDirty &&
            repoAccess &&
            repoAccess.missing.length > 0 && (
              <GitAccessNotice
                heading="Deplo is missing access on GitHub"
                items={repoAccess.missing}
                fix={
                  canManageGit
                    ? {
                        href: repoAccess.settingsUrl,
                        label: "Update on GitHub",
                      }
                    : null
                }
              />
            )}
          {(usesGithubApp || usesGitUrl) && !sourceDirty && cloneRefusal && (
            <GitAccessNotice
              heading="This repository will not clone"
              note={cloneRefusal}
            />
          )}

          {/* The one case auto-registration cannot cover: a token without the
              webhook scope. None of these hosts reports its own scopes, so the
              checklist waits for a real refusal rather than nagging. */}
          {usesGitUrl && webhook?.applicable && !webhook.installed && (
            <div className="rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
              <p className="text-xs font-medium">
                Deplo could not add the push webhook
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {webhook.error ||
                  "Add it in your repository's webhook settings so a push deploys."}
              </p>
              {connectionAccess.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {connectionAccess.map((r) => (
                    <li key={r.key} className="text-xs">
                      <span className="font-medium">{r.label}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        - {r.unlocks}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {webhook.url && (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                  <code className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all">
                    {webhook.url}
                  </code>
                  <CopyButton
                    value={webhook.url}
                    className="shrink-0"
                    label="Copy webhook URL"
                  />
                </div>
              )}
            </div>
          )}

          {source === "docker-image" && (
            <div className="space-y-2">
              <FieldLabel
                info={
                  <>
                    Start typing to search registries; add{" "}
                    <code className="font-mono">:</code> to pick a tag. A green
                    check confirms the image exists.
                  </>
                }
                docs="deploy.dockerImage"
              >
                Docker image
              </FieldLabel>
              <ImageInput value={dockerImage} onChange={setDockerImage} />
            </div>
          )}

          {source === "upload" && (
            <UploadInput appId={appId} current={initialUpload} />
          )}

          {source === "compose" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel
                  className="flex items-center gap-1.5"
                  info="The Compose file defining this stack's services. Deplo builds or pulls each service's image and deploys them together."
                  docs="compose.overview"
                >
                  <FileText className="size-3.5" />
                  docker-compose.yml
                </FieldLabel>
                <FullComposeDialog appId={appId} />
              </div>
              <ComposeEditor
                value={compose}
                onChange={setCompose}
                onDiagnostics={setComposeDiags}
                minHeight={340}
              />
              <ComposeLintSummary diagnostics={composeDiags} />
            </div>
          )}

          {/* Always here, because the Server picker is: every source runs
              somewhere, while the root directory only applies to a repo Deplo
              compiles. */}
          <AdditionalOptionsDrawer
            settings={settings}
            servers={servers}
            neighbours={neighbours}
          />
        </AnimatedHeight>
      </CardContent>
      <CardFooter className="justify-between border-t border-border pt-4">
        {source === "upload" ? (
          <>
            <DirtyHint dirty={deploySourceCardDirty} />
            <Button
              onClick={saveAndDeploy}
              disabled={pending || !initialUpload}
            >
              <Rocket className="size-4" />
              Save &amp; Deploy
            </Button>
          </>
        ) : (
          <>
            <DirtyHint dirty={deploySourceCardDirty} />
            <Button
              onClick={saveSource}
              disabled={pending || !deploySourceCardDirty}
            >
              <Save className="size-4" />
              Save source
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}
