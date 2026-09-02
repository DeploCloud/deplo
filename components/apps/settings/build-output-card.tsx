"use client";

import * as React from "react";
import { Save } from "lucide-react";
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
import { OverrideRow } from "@/components/shared/override-row";
import { BuildMethodFields } from "@/components/apps/build-method-fields";
import { NodeVersionInput } from "@/components/apps/node-version-input";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { frameworkById } from "@/lib/apps/framework-catalog";
import { DEFAULT_NODE_MAJOR, usesDefaultNodeMajor } from "@/lib/frameworks";
import type {
  BuildConfig,
  BuildMethod,
  BuildMethodSettings,
} from "@/lib/types";

/**
 * Build & output - one row per decision. A row only appears where the builder
 * actually reads that field, so nothing here can silently do nothing.
 */

/**
 * The stored empty string means "Deplo works it out", so it is the OFF state of
 * an override, not a value. See ADR/plan: null and "" become distinct later.
 */
function overrideOf(stored: string | null | undefined): string | null {
  return stored && stored.length > 0 ? stored : null;
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
  /** The framework in force - the user's correction if any, else what the last
   * deploy detected. */
  framework: string | null;
  /** What DETECTION read, so the card can say whose answer is showing. */
  detectedFramework: string | null;
  onFrameworkChange: (id: string | null) => void;
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
}) {
  function setBuild(updater: (b: BuildConfig) => BuildConfig) {
    onBuildChange(updater(build));
  }

  // Which overrides the deploy path actually consumes, per builder - a field is shown
  // only where the agent-side builder reads it, so nothing here can silently do
  // nothing: - nixpacks / railpack: build + start commands, Node version - static:
  // build command + Node version (the builder stage); nginx serves the output, so
  // there is no process to start - dockerfile: none - the repo's Dockerfile owns
  // install/build/run
  const method = build.buildMethod;
  const showBuildCommand =
    method === "nixpacks" || method === "railpack" || method === "static";
  const showStartCommand = method === "nixpacks" || method === "railpack";
  const showNodeVersion =
    method === "nixpacks" || method === "railpack" || method === "static";
  // Install and output are read by the same builders that read the build command;
  // a Dockerfile owns all four itself.
  const showInstallCommand = showBuildCommand;
  const showOutputDirectory = method === "static";

  // The port field keeps a DRAFT of what is typed so it can be emptied mid-edit.
  const [portDraft, setPortDraft] = React.useState<string | null>(null);
  const portText = portDraft ?? String(build.port);

  function onPortChange(text: string) {
    setPortDraft(text);
    const n = Number(text);
    if (text.trim() !== "" && Number.isInteger(n) && n > 0)
      setBuild((b) => ({ ...b, port: n }));
  }

  /**
   * Correcting the framework carries the container port with it - that is the
   * whole reason the setting is worth having (`vite preview` binds 4173 and
   * ignores PORT, so an app mis-read as Next.js deploys green and answers
   * nothing).
   */
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
          // The framework is one of the BUILDER's settings - only the
          // auto-detecting ones read the source, so it renders inside their
          // options panel rather than as a row of its own.
          framework={framework}
          detectedFramework={detectedFramework}
          onFrameworkChange={pickFramework}
        />

        {/* Each command is shown as a decision - Deplo works it out, or you take
            it over. No detected value is printed: nixpacks and railpack settle
            these inside the agent, and a guess here would read as a promise. */}
        {showInstallCommand && (
          <OverrideRow
            label="Install command"
            id="install-command"
            info="Overrides how dependencies are installed before the build."
            docs="build.fields"
            value={overrideOf(build.installCommand)}
            onChange={(v) =>
              setBuild((b) => ({ ...b, installCommand: v ?? "" }))
            }
            placeholder="npm ci"
            disabled={pending}
          />
        )}

        {showBuildCommand && (
          <OverrideRow
            label="Build command"
            id="build-command"
            info="Overrides the command that builds your app."
            docs="build.fields"
            value={overrideOf(build.buildCommand)}
            onChange={(v) => setBuild((b) => ({ ...b, buildCommand: v ?? "" }))}
            placeholder="npm run build"
            disabled={pending}
          />
        )}

        {showStartCommand && (
          <OverrideRow
            label="Start command"
            id="start-command"
            info="Overrides the command that starts your app inside the container."
            docs="build.fields"
            value={overrideOf(build.startCommand)}
            onChange={(v) => setBuild((b) => ({ ...b, startCommand: v ?? "" }))}
            placeholder="node server.js"
            disabled={pending}
          />
        )}

        {showOutputDirectory && (
          <OverrideRow
            label="Output directory"
            id="output-directory"
            info="The directory the build writes to, when it is not the builder's own."
            docs="build.fields"
            value={overrideOf(build.outputDirectory)}
            onChange={(v) =>
              setBuild((b) => ({ ...b, outputDirectory: v ?? "" }))
            }
            placeholder="dist"
            disabled={pending}
          />
        )}

        {showNodeVersion && (
          <OverrideRow
            label="Node.js version"
            id="node-version"
            info={
              usesDefaultNodeMajor(method)
                ? `Pins the Node.js major. Off uses Node ${DEFAULT_NODE_MAJOR}.`
                : "Pins the Node.js major. Off reads it from your project."
            }
            docs="build.fields"
            detectedLabel={
              usesDefaultNodeMajor(method)
                ? `Node ${DEFAULT_NODE_MAJOR}`
                : "Read from your project"
            }
            value={overrideOf(build.runtimeVersion)}
            onChange={(v) =>
              setBuild((b) => ({ ...b, runtimeVersion: v ?? "" }))
            }
            mono={false}
            disabled={pending}
            control={({ value, onChange, id }) => (
              <NodeVersionInput
                id={id}
                value={value}
                onChange={onChange}
                className="max-w-xs"
              />
            )}
          />
        )}

        <SettingRow
          label="Container port"
          htmlFor="container-port"
          info="The port your app listens on inside the container (Traefik routes here)."
          docs="build.port"
        >
          <Input
            id="container-port"
            type="number"
            min={1}
            className="max-w-32 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            value={portText}
            disabled={pending}
            onChange={(e) => onPortChange(e.target.value)}
            onBlur={() => setPortDraft(null)}
          />
        </SettingRow>
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
