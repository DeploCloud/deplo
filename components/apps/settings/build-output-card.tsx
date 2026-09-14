"use client";

import * as React from "react";
import {
  Braces,
  FolderOutput,
  Hammer,
  Package,
  Play,
  Plug,
  Save,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InfoTip } from "@/components/ui/info-tip";
import { SettingRow } from "@/components/shared/setting-row";
import { BuildMethodFields } from "@/components/apps/build-method-fields";
import { NodeVersionInput } from "@/components/apps/node-version-input";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { frameworkById } from "@/lib/apps/framework-catalog";
import { DEFAULT_NODE_MAJOR, usesDefaultNodeMajor } from "@/lib/frameworks";
import type {
  BuildConfig,
  BuildMethod,
  BuildMethodSettings,
} from "@/lib/types/build";

function defaultsFor(method: string) {
  if (method === "dockerfile")
    return {
      install: "npm ci --include=dev",
      build: "no build step",
      start: "node server.js",
    };
  return { install: "npm ci", build: "npm run build", start: "npm run start" };
}
export function BuildOutputCard({
  build,
  onBuildChange,
  framework,
  detectedFramework,
  onFrameworkChange,
  dirty,
  pending,
  onSave,
}: {
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
  framework: string | null;
  detectedFramework: string | null;
  onFrameworkChange: (id: string | null) => void;
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
}) {
  function setBuild(updater: (b: BuildConfig) => BuildConfig) {
    onBuildChange(updater(build));
  }

  const method = build.buildMethod;
  const showBuildCommand =
    method === "nixpacks" || method === "railpack" || method === "static";
  const showStartCommand = method === "nixpacks" || method === "railpack";
  const showNodeVersion =
    method === "nixpacks" || method === "railpack" || method === "static";
  const showInstallCommand = showBuildCommand;
  const showOutputDirectory = method === "static";

  // Empty is "work it out" (null), never the empty string that skips a step.
  function setCommand(
    key: "installCommand" | "buildCommand" | "startCommand" | "outputDirectory",
    value: string,
  ) {
    setBuild((b) => ({ ...b, [key]: value === "" ? null : value }));
  }

  const [portDraft, setPortDraft] = React.useState<string | null>(null);
  const portText = portDraft ?? String(build.port);

  function onPortChange(text: string) {
    setPortDraft(text);
    const n = Number(text);
    if (text.trim() !== "" && Number.isInteger(n) && n > 0)
      setBuild((b) => ({ ...b, port: n }));
  }

  // The port follows the framework: `vite preview` binds 4173 and ignores PORT.
  function pickFramework(next: string | null) {
    const previousPort = frameworkById(framework)?.defaultPort ?? 3000;
    const nextPort = frameworkById(next ?? detectedFramework)?.defaultPort;
    if (nextPort && build.port === previousPort) {
      setPortDraft(null);
      setBuild((b) => ({ ...b, port: nextPort }));
    }
    onFrameworkChange(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Build &amp; output
          <InfoTip
            content="What happens between your code and a running container."
            docs="build.methods"
          />
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        <BuildMethodFields
          method={build.buildMethod}
          settings={build.methodSettings}
          onMethodChange={(m: BuildMethod) =>
            setBuild((b) => ({ ...b, buildMethod: m }))
          }
          onSettingsChange={(patch: Partial<BuildMethodSettings>) =>
            setBuild((b) => ({
              ...b,
              methodSettings: { ...b.methodSettings, ...patch },
            }))
          }
          framework={framework}
          detectedFramework={detectedFramework}
          onFrameworkChange={pickFramework}
        />

        {/* Each command is a decision: Deplo works it out, or you take it over. */}
        {/* Two to a row from sm: each is one short field. */}
        <div className="grid gap-3 sm:grid-cols-2">
          {showInstallCommand && (
            <SettingRow
              label="Install command"
              icon={Package}
              htmlFor="install-command"
              info="Overrides how dependencies are installed before the build."
              docs="build.fields"
            >
              <Input
                id="install-command"
                className="w-full font-mono text-xs"
                placeholder={defaultsFor(method).install}
                value={build.installCommand ?? ""}
                disabled={pending}
                onChange={(e) => setCommand("installCommand", e.target.value)}
              />
            </SettingRow>
          )}

          {showBuildCommand && (
            <SettingRow
              label="Build command"
              icon={Hammer}
              htmlFor="build-command"
              info="Overrides the command that builds your app."
              docs="build.fields"
            >
              <Input
                id="build-command"
                className="w-full font-mono text-xs"
                placeholder={defaultsFor(method).build}
                value={build.buildCommand ?? ""}
                disabled={pending}
                onChange={(e) => setCommand("buildCommand", e.target.value)}
              />
            </SettingRow>
          )}

          {showStartCommand && (
            <SettingRow
              label="Start command"
              icon={Play}
              htmlFor="start-command"
              info="Overrides the command that starts your app inside the container."
              docs="build.fields"
            >
              <Input
                id="start-command"
                className="w-full font-mono text-xs"
                placeholder={defaultsFor(method).start}
                value={build.startCommand ?? ""}
                disabled={pending}
                onChange={(e) => setCommand("startCommand", e.target.value)}
              />
            </SettingRow>
          )}

          {showOutputDirectory && (
            <SettingRow
              label="Output directory"
              icon={FolderOutput}
              htmlFor="output-directory"
              info="The directory the build writes to, when it is not the builder's own."
              docs="build.fields"
            >
              <Input
                id="output-directory"
                className="w-full font-mono text-xs"
                placeholder="dist"
                value={build.outputDirectory ?? ""}
                disabled={pending}
                onChange={(e) => setCommand("outputDirectory", e.target.value)}
              />
            </SettingRow>
          )}

          {showNodeVersion && (
            <SettingRow
              label="Node.js version"
              icon={Braces}
              htmlFor="node-version"
              info={
                usesDefaultNodeMajor(method)
                  ? `Pins the Node.js major. Empty uses Node ${DEFAULT_NODE_MAJOR}.`
                  : "Pins the Node.js major. Empty reads it from your project."
              }
              docs="build.fields"
            >
              <NodeVersionInput
                id="node-version"
                className="w-full"
                value={build.runtimeVersion ?? ""}
                onChange={(v) => setBuild((b) => ({ ...b, runtimeVersion: v }))}
                placeholder={
                  usesDefaultNodeMajor(method)
                    ? `Node ${DEFAULT_NODE_MAJOR}`
                    : "read from your project"
                }
              />
            </SettingRow>
          )}

          <SettingRow
            label="Container port"
            icon={Plug}
            htmlFor="container-port"
            info="The port your app listens on inside the container (Traefik routes here)."
            docs="build.port"
          >
            <Input
              id="container-port"
              type="number"
              min={1}
              className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              value={portText}
              disabled={pending}
              onChange={(e) => onPortChange(e.target.value)}
              onBlur={() => setPortDraft(null)}
            />
          </SettingRow>
        </div>
      </CardContent>

      <CardFooter className="justify-between border-t border-border pt-4">
        <DirtyHint dirty={dirty} />
        <Button onClick={onSave} disabled={pending || !dirty}>
          <Save className="size-4" />
          Save build settings
        </Button>
      </CardFooter>
    </Card>
  );
}
