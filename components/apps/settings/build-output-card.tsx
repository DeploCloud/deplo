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
          method={method}
          settings={build.methodSettings}
          onMethodChange={(m) => setBuild((b) => withMethodChoice(b, m))}
          onSettingsChange={(patch: Partial<BuildMethodSettings>) =>
            setBuild((b) => ({
              ...b,
              methodSettings: { ...b.methodSettings, ...patch },
            }))
          }
          lastBuiltWith={lastBuiltWith}
          framework={framework}
          detectedFramework={detectedFramework}
          onFrameworkChange={pickFramework}
        />

        {(railpack || showPort) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {railpack && (
              <>
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
                    placeholder="npm ci"
                    value={build.installCommand ?? ""}
                    disabled={pending}
                    onChange={(e) =>
                      setCommand("installCommand", e.target.value)
                    }
                  />
                </SettingRow>

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
                    placeholder="npm run build"
                    value={build.buildCommand ?? ""}
                    disabled={pending}
                    onChange={(e) => setCommand("buildCommand", e.target.value)}
                  />
                </SettingRow>

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
                    placeholder="npm run start"
                    value={build.startCommand ?? ""}
                    disabled={pending}
                    onChange={(e) => setCommand("startCommand", e.target.value)}
                  />
                </SettingRow>

                <SettingRow
                  label="Output directory"
                  icon={FolderOutput}
                  htmlFor="output-directory"
                  info="Serves the folder your build writes as a static site. Leave it empty for an app that runs its own server."
                  docs="build.fields"
                >
                  <Input
                    id="output-directory"
                    className="w-full font-mono text-xs"
                    placeholder="dist"
                    value={build.outputDirectory ?? ""}
                    disabled={pending}
                    onChange={(e) =>
                      setCommand("outputDirectory", e.target.value)
                    }
                  />
                </SettingRow>

                <SettingRow
                  label="Node.js version"
                  icon={Braces}
                  htmlFor="node-version"
                  info="Pins the Node.js major. Empty reads it from your project."
                  docs="build.fields"
                >
                  <NodeVersionInput
                    id="node-version"
                    className="w-full"
                    value={build.runtimeVersion ?? ""}
                    onChange={(v) =>
                      setBuild((b) => ({ ...b, runtimeVersion: v }))
                    }
                    placeholder="read from your project"
                  />
                </SettingRow>
              </>
            )}

            {showPort && (
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
            )}
          </div>
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
