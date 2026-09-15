"use client";

import { Server as ServerIcon, Variable } from "lucide-react";

import { BuildConfigFields } from "@/components/apps/build-config-fields";
import {
  GitDeployOptions,
  type GitDeployOptionsValue,
} from "@/components/apps/git-deploy-options";
import { RootDirectoryFields } from "@/components/apps/settings/root-directory-fields";
import type { DraftEnvRow } from "@/components/apps/wizard/env-draft-dialog";
import {
  AdvancedSection,
  AdvancedGroup,
} from "@/components/apps/wizard/advanced-section";
import { ServerRoleHint } from "@/components/shared/server-role-hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LintDiagnostic } from "@/lib/deploy/compose-lint/lint";
import type { DeploySource } from "@/lib/types/app";
import type { BuildConfig } from "@/lib/types/build";
import { serverLabel } from "@/lib/utils";

import { ComposeSummary } from "./compose-summary";
import type { WizardBuildServer, WizardServer } from "./types";

const AUTO_BUILD_SERVER = "__auto__";

export function WizardAdvanced({
  servers,
  serverId,
  setServerId,
  buildServers,
  buildServerId,
  setBuildServerId,
  envRows,
  sharedIds,
  onEditEnv,
  source,
  useCompose,
  templateCompose,
  buildsImage,
  usesGit,
  build,
  onBuildChange,
  gitOptions,
  setGitOptions,
  composeServices,
  composeDiags,
  onOpenCompose,
  composeUpArgs,
  setComposeUpArgs,
  composeArgsProblem,
}: {
  servers: WizardServer[];
  serverId: string;
  setServerId: (value: string) => void;
  buildServers: WizardBuildServer[];
  buildServerId: string | null;
  setBuildServerId: (value: string | null) => void;
  envRows: DraftEnvRow[];
  sharedIds: string[];
  onEditEnv: () => void;
  source: DeploySource | null;
  useCompose: boolean;
  templateCompose: boolean;
  buildsImage: boolean;
  usesGit: boolean;
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
  gitOptions: GitDeployOptionsValue;
  setGitOptions: (value: GitDeployOptionsValue) => void;
  composeServices: string[];
  composeDiags: LintDiagnostic[];
  onOpenCompose: () => void;
  composeUpArgs: string;
  setComposeUpArgs: (value: string) => void;
  composeArgsProblem: string | null;
}) {
  const selectedServer = servers.find((s) => s.id === serverId);

  return (
    <AdvancedSection
      summary={selectedServer ? serverLabel(selectedServer) : undefined}
    >
      <AdvancedGroup title="Deploy to">
        <Select value={serverId} onValueChange={setServerId}>
          <SelectTrigger>
            <SelectValue placeholder="Select a server" />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="flex items-center gap-2">
                  <ServerIcon className="size-4 text-muted-foreground" />
                  {serverLabel(s)}
                  <ServerRoleHint isDeploHost={s.isDeploHost} />
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </AdvancedGroup>

      <AdvancedGroup title="Environment variables">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {envRows.length + sharedIds.length === 0
              ? "None yet"
              : `${envRows.length} typed, ${sharedIds.length} shared`}
          </p>
          <Button type="button" variant="outline" onClick={onEditEnv}>
            <Variable className="size-4" />
            Edit variables
          </Button>
        </div>
      </AdvancedGroup>

      {source === "docker-image" && !useCompose && (
        <AdvancedGroup title="Port">
          <FieldLabel
            htmlFor="image-port"
            info="The port the image listens on inside the container (Traefik routes here). Filled in from the image when it declares one."
            docs="build.port"
          >
            Container port
          </FieldLabel>
          <Input
            id="image-port"
            type="number"
            inputMode="numeric"
            min={1}
            value={String(build.port)}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n))
                onBuildChange({ ...build, port: Math.max(1, Math.round(n)) });
            }}
          />
        </AdvancedGroup>
      )}

      {buildsImage && (
        <>
          <BuildConfigFields
            build={build}
            onBuildChange={onBuildChange}
            commands={!usesGit}
          />
          <AdvancedGroup title="Build path">
            <RootDirectoryFields build={build} onBuildChange={onBuildChange} />
          </AdvancedGroup>
          <AdvancedGroup title="Build on">
            <Select
              value={buildServerId ?? AUTO_BUILD_SERVER}
              onValueChange={(v) =>
                setBuildServerId(v === AUTO_BUILD_SERVER ? null : v)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_BUILD_SERVER}>Automatic</SelectItem>
                {buildServers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="flex items-center gap-2">
                      <ServerIcon className="size-4 text-muted-foreground" />
                      {s.name}
                      <ServerRoleHint isDeploHost={s.isDeploHost} />
                      {s.buildOnly && (
                        <Badge variant="outline">Build server</Badge>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </AdvancedGroup>
        </>
      )}

      {usesGit && (
        <AdvancedGroup title="Git">
          <GitDeployOptions value={gitOptions} onChange={setGitOptions} />
        </AdvancedGroup>
      )}

      {templateCompose && (
        <AdvancedGroup title="Compose">
          <ComposeSummary
            services={composeServices}
            diagnostics={composeDiags}
            onOpen={onOpenCompose}
          />
        </AdvancedGroup>
      )}

      {useCompose && (
        <AdvancedGroup title="Extra compose flags">
          <Input
            id="compose-up-args"
            value={composeUpArgs}
            onChange={(e) => setComposeUpArgs(e.target.value)}
            placeholder="--pull always"
            className="font-mono text-sm"
            aria-invalid={Boolean(composeArgsProblem)}
          />
          {composeArgsProblem && (
            <p className="mt-1 text-xs text-destructive">
              {composeArgsProblem}
            </p>
          )}
        </AdvancedGroup>
      )}
    </AdvancedSection>
  );
}
