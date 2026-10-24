"use client";

import * as React from "react";
import { Hammer, Save } from "lucide-react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { SettingsDrawer } from "@/components/shared/settings-drawer";
import {
  BuildMethodFields,
  RailpackOptions,
  TextField,
} from "@/components/apps/build-method-fields";
import { NodeVersionInput } from "@/components/apps/node-version-input";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { frameworkById } from "@/lib/apps/framework-catalog";
import {
  buildsWithRailpack,
  methodChoice,
  withMethodChoice,
} from "@/lib/apps/build-method";
import type {
  BuildConfig,
  BuildMethod,
  BuildMethodSettings,
} from "@/lib/types/build";

export function BuildOutputCard({
  build,
  onBuildChange,
  lastBuiltWith,
  framework,
  detectedFramework,
  onFrameworkChange,
  dirty,
  pending,
  onSave,
}: {
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
  lastBuiltWith: BuildMethod | null;
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

  const method = methodChoice(build);
  const railpack = buildsWithRailpack(method);
  // A compose stack's port is the routed service's, set per domain.
  const showPort = method !== "compose";

  // Empty is "work it out" (null), never the empty string that skips a step.
  function setCommand(
    key: "installCommand" | "buildCommand" | "startCommand" | "outputDirectory",
    value: string,
  ) {
    setBuild((b) => ({ ...b, [key]: value === "" ? null : value }));
  }

  const onMethodChange = (m: typeof method) =>
    setBuild((b) => withMethodChoice(b, m));
  const onSettingsChange = (patch: Partial<BuildMethodSettings>) =>
    setBuild((b) => ({
      ...b,
      methodSettings: { ...b.methodSettings, ...patch },
    }));

  const [portDraft, setPortDraft] = React.useState<string | null>(null);
  const portText = portDraft ?? String(build.port);

  function onPortChange(text: string) {
    setPortDraft(text);
    const n = Number(text);
    if (text.trim() !== "" && Number.isInteger(n) && n > 0)
      setBuild((b) => ({ ...b, port: n }));
  }

  function pickFramework(next: string | null) {
    const previousPort = frameworkById(framework)?.defaultPort ?? 3000;
    const nextPort = frameworkById(next ?? detectedFramework)?.defaultPort;
    if (nextPort && build.port === previousPort) {
      setPortDraft(null);
      setBuild((b) => ({ ...b, port: nextPort }));
    }
    onFrameworkChange(next);
  }

  const overrides = [
    build.installCommand && "Install command",
    build.buildCommand && "Build command",
    build.startCommand && "Start command",
    build.outputDirectory && "Output directory",
    build.runtimeVersion && `Node.js ${build.runtimeVersion}`,
    build.methodSettings.staticSinglePageApp && "Single-page application",
    method === "railpack" && "Always Railpack",
  ].filter(Boolean);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <Hammer className="size-4 text-muted-foreground" />
          Build
          <InfoTip
            content="How Deplo turns your code into a running app."
            docs="build.methods"
          />
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <BuildMethodFields
          method={method}
          settings={build.methodSettings}
          onMethodChange={onMethodChange}
          onSettingsChange={onSettingsChange}
          lastBuiltWith={lastBuiltWith}
          framework={framework}
          detectedFramework={detectedFramework}
          onFrameworkChange={pickFramework}
        >
          {showPort && (
            <div className="space-y-2">
              <FieldLabel
                htmlFor="container-port"
                info="The port your app listens on. Deplo sends its traffic there."
                docs="build.port"
              >
                Port
              </FieldLabel>
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
            </div>
          )}
        </BuildMethodFields>

        {railpack && (
          <SettingsDrawer
            title="Advanced"
            summary={
              overrides.length > 0
                ? overrides.join(" · ")
                : "Commands detected from your code"
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Install command"
                placeholder="npm ci"
                value={build.installCommand ?? ""}
                disabled={pending}
                onChange={(v) => setCommand("installCommand", v)}
                help="Overrides how dependencies are installed before the build."
                docs="build.fields"
              />
              <TextField
                label="Build command"
                placeholder="npm run build"
                value={build.buildCommand ?? ""}
                disabled={pending}
                onChange={(v) => setCommand("buildCommand", v)}
                help="Overrides the command that builds your app."
                docs="build.fields"
              />
              <TextField
                label="Start command"
                placeholder="npm run start"
                value={build.startCommand ?? ""}
                disabled={pending}
                onChange={(v) => setCommand("startCommand", v)}
                help="Overrides the command that starts your app."
                docs="build.fields"
              />
              <TextField
                label="Output directory"
                placeholder="dist"
                value={build.outputDirectory ?? ""}
                disabled={pending}
                onChange={(v) => setCommand("outputDirectory", v)}
                help="Serves this folder as a static site. Leave it empty for an app that runs its own server."
                docs="build.fields"
              />
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="node-version"
                  info="Pins the Node.js major. Empty reads it from your project."
                  docs="build.fields"
                >
                  Node.js version
                </FieldLabel>
                <NodeVersionInput
                  id="node-version"
                  className="w-full"
                  value={build.runtimeVersion ?? ""}
                  onChange={(v) =>
                    setBuild((b) => ({ ...b, runtimeVersion: v }))
                  }
                  placeholder="read from your project"
                />
              </div>
            </div>
            <RailpackOptions
              method={method}
              settings={build.methodSettings}
              onMethodChange={onMethodChange}
              onSettingsChange={onSettingsChange}
            />
          </SettingsDrawer>
        )}
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
