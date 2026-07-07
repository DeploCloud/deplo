"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FrameworkGlyph } from "@/components/shared/framework-icon";
import { FRAMEWORK_LIST, buildConfigFor, runtimeFor } from "@/lib/frameworks";
import { BuildMethodFields } from "@/components/services/build-method-fields";
import type {
  BuildConfig,
  BuildMethod,
  BuildMethodSettings,
  FrameworkId,
} from "@/lib/types";

/**
 * The build-method-aware "Build & Output" section shared by the new-project
 * wizard and the service settings form, so the two stay byte-for-byte in sync.
 *
 * Owns no persistence: the parent holds the BuildConfig and decides how/when to
 * save it. This component only renders the method picker + the command/runtime/
 * port fields, surfacing exactly the controls the active build method consumes.
 */
export function BuildConfigFields({
  build,
  framework,
  onBuildChange,
  onFrameworkChange,
}: {
  build: BuildConfig;
  framework: FrameworkId;
  onBuildChange: (next: BuildConfig) => void;
  onFrameworkChange: (fw: FrameworkId) => void;
}) {
  function setBuild(updater: (b: BuildConfig) => BuildConfig) {
    onBuildChange(updater(build));
  }

  function setBuildMethod(method: BuildMethod) {
    setBuild((b) => ({ ...b, buildMethod: method }));
  }

  function patchMethodSettings(patch: Partial<BuildMethodSettings>) {
    setBuild((b) => ({
      ...b,
      methodSettings: { ...b.methodSettings, ...patch },
    }));
  }

  // The framework preset and the install/build/output/start command fields only
  // affect the two methods that consume them: Nixpacks (as optional overrides)
  // and Static (which runs a two-stage build). Dockerfile, Railpack, and the
  // buildpack methods (Heroku/Paketo) auto-detect the language and ignore them,
  // so showing those controls there would be misleading.
  const usesFrameworkCommands =
    build.buildMethod === "nixpacks" || build.buildMethod === "static";
  // The runtime-version field is language-aware and only meaningful when Deplo
  // controls the build toolchain AND the framework has a pinnable runtime.
  const runtime = runtimeFor(framework);
  const showRuntimeVersion =
    usesFrameworkCommands && runtime.language !== "none";
  // Static serves a directory of files; its "build command" is what produces
  // them, and its output dir is what nginx serves.
  const isStatic = build.buildMethod === "static";

  return (
    <div className="space-y-6">
      <BuildMethodFields
        method={build.buildMethod}
        settings={build.methodSettings}
        onMethodChange={setBuildMethod}
        onSettingsChange={patchMethodSettings}
      />

      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        {usesFrameworkCommands ? (
          <>
            <div className="space-y-2">
              <Label>Framework Preset</Label>
              <Select
                value={framework}
                onValueChange={(v) => onFrameworkChange(v as FrameworkId)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FRAMEWORK_LIST.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      <span className="flex items-center gap-2">
                        <FrameworkGlyph framework={f.id} />
                        {f.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {build.buildMethod === "nixpacks"
                  ? "Optional overrides — Nixpacks auto-detects these if left as the preset defaults."
                  : "Seeds the build commands that produce your static output."}
              </p>
            </div>
            <Field
              label="Root Directory"
              value={build.rootDirectory}
              onChange={(v) => setBuild((b) => ({ ...b, rootDirectory: v }))}
            />
            <Field
              label="Install Command"
              value={build.installCommand}
              onChange={(v) => setBuild((b) => ({ ...b, installCommand: v }))}
            />
            <Field
              label="Build Command"
              value={build.buildCommand}
              onChange={(v) => setBuild((b) => ({ ...b, buildCommand: v }))}
            />
            <Field
              label="Output Directory"
              value={build.outputDirectory}
              onChange={(v) => setBuild((b) => ({ ...b, outputDirectory: v }))}
            />
            {/* Static is served by nginx, so there is no app start command. */}
            {!isStatic && (
              <Field
                label="Start Command"
                value={build.startCommand}
                onChange={(v) => setBuild((b) => ({ ...b, startCommand: v }))}
              />
            )}
            {showRuntimeVersion && (
              <Field
                label={runtime.versionLabel}
                value={build.runtimeVersion}
                onChange={(v) => setBuild((b) => ({ ...b, runtimeVersion: v }))}
              />
            )}
          </>
        ) : (
          <>
            <Field
              label="Root Directory"
              value={build.rootDirectory}
              onChange={(v) => setBuild((b) => ({ ...b, rootDirectory: v }))}
            />
            <p className="self-end text-xs text-muted-foreground sm:col-span-2">
              {build.buildMethod === "dockerfile"
                ? "Your Dockerfile controls how the app is installed, built and started."
                : "This builder auto-detects your language and build steps — no framework preset needed."}
            </p>
          </>
        )}
        <div className="space-y-2">
          <Label>Container Port</Label>
          <Input
            type="number"
            value={build.port}
            onChange={(e) =>
              setBuild((b) => ({ ...b, port: Number(e.target.value) || 3000 }))
            }
          />
          <p className="text-xs text-muted-foreground">
            The port your app listens on inside the container (Traefik routes
            here).
          </p>
        </div>
      </div>
    </div>
  );
}

/** Re-export so callers can reuse the same framework-change semantics. */
export function applyFrameworkToBuild(
  build: BuildConfig,
  fw: FrameworkId,
): BuildConfig {
  return {
    ...buildConfigFor(fw),
    rootDirectory: build.rootDirectory,
    // Keep the user's chosen build method and its settings across a framework
    // change; only the command presets follow the new framework.
    buildMethod: build.buildMethod,
    methodSettings: build.methodSettings,
  };
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
      />
    </div>
  );
}
