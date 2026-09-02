"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { BuildMethodFields } from "@/components/apps/build-method-fields";
import { NodeVersionInput } from "@/components/apps/node-version-input";
import { DEFAULT_NODE_MAJOR, usesDefaultNodeMajor } from "@/lib/frameworks";
import type {
  BuildConfig,
  BuildMethod,
  BuildMethodSettings,
} from "@/lib/types";

/**
 * The build-method-aware "Build & Output" section of the NEW-APP WIZARD: build
 * method, the commands, and the runtime, in the order the questions get asked.
 */
export function BuildConfigFields({
  build,
  onBuildChange,
  commands = true,
}: {
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
  /** False where the card already asks for them at its own level. */
  commands?: boolean;
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

  // Build command / start command / Node version are optional OVERRIDES for the
  // auto-detecting builders.
  const method = build.buildMethod;
  const showBuildCommand =
    method === "nixpacks" || method === "railpack" || method === "static";
  const showStartCommand = method === "nixpacks" || method === "railpack";
  const showNodeVersion =
    method === "nixpacks" || method === "railpack" || method === "static";
  const showCommands = commands && (showBuildCommand || showStartCommand);

  // The port field keeps a DRAFT of what is typed so it can be emptied mid-edit.
  const [portDraft, setPortDraft] = React.useState<string | null>(null);
  const portText = portDraft ?? String(build.port);

  function onPortChange(text: string) {
    setPortDraft(text);
    const n = Number(text);
    if (text.trim() !== "" && Number.isInteger(n) && n > 0) {
      setBuild((b) => ({ ...b, port: n }));
    }
  }

  /** Leaving the field drops the draft, so the box shows the committed port
   * again, which is what restores it after it was emptied or left invalid. */
  function onPortBlur() {
    setPortDraft(null);
  }

  return (
    <div className="space-y-5">
      <FieldGroup title="Build method" first>
        <BuildMethodFields
          method={build.buildMethod}
          settings={build.methodSettings}
          onMethodChange={setBuildMethod}
          onSettingsChange={patchMethodSettings}
        />
      </FieldGroup>

      {showCommands && (
        <FieldGroup
          title="Commands"
          hint="Leave blank to let the builder work them out from your code."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {showBuildCommand && (
              <div className="space-y-2">
                <FieldLabel
                  info="Overrides the command that builds your app. Leave blank to let the builder detect it."
                  docs="build.fields"
                >
                  Build command
                </FieldLabel>
                <Input
                  className="font-mono text-xs"
                  placeholder="(auto-detected)"
                  value={build.buildCommand ?? ""}
                  onChange={(e) =>
                    setBuild((b) => ({ ...b, buildCommand: e.target.value }))
                  }
                />
              </div>
            )}

            {showStartCommand && (
              <div className="space-y-2">
                <FieldLabel
                  info="Overrides the command that starts your app inside the container."
                  docs="build.fields"
                >
                  Start command
                </FieldLabel>
                <Input
                  className="font-mono text-xs"
                  placeholder="(auto-detected)"
                  value={build.startCommand ?? ""}
                  onChange={(e) =>
                    setBuild((b) => ({ ...b, startCommand: e.target.value }))
                  }
                />
              </div>
            )}
          </div>
        </FieldGroup>
      )}

      <FieldGroup title="Runtime">
        <div className="grid gap-4 sm:grid-cols-2">
          {showNodeVersion && (
            <div className="space-y-2">
              <FieldLabel
                info={
                  <>
                    Pins the Node.js major, kept in sync with the real Node
                    releases.
                    {usesDefaultNodeMajor(method)
                      ? ` Leave blank to use the default (Node ${DEFAULT_NODE_MAJOR}).`
                      : " Leave blank to auto-detect from your project."}
                  </>
                }
                docs="build.fields"
              >
                Node.js version
              </FieldLabel>
              <NodeVersionInput
                value={build.runtimeVersion}
                onChange={(v) => setBuild((b) => ({ ...b, runtimeVersion: v }))}
                placeholder={
                  usesDefaultNodeMajor(method)
                    ? `Default (Node ${DEFAULT_NODE_MAJOR})`
                    : "Default (auto-detect)"
                }
              />
            </div>
          )}

          <div className="space-y-2">
            <FieldLabel
              info="The port your app listens on inside the container (Traefik routes here)."
              docs="build.port"
            >
              Container port
            </FieldLabel>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={portText}
              onChange={(e) => onPortChange(e.target.value)}
              onBlur={onPortBlur}
            />
          </div>
        </div>
      </FieldGroup>
    </div>
  );
}

/**
 * One titled group of fields. A rule + a quiet heading rather than another
 * bordered box: the method options and the framework already own panels, and a
 * card of nested boxes reads as noise.
 */
function FieldGroup({
  title,
  hint,
  first,
  children,
}: {
  title: string;
  /** What the group is for. Read in the title's tooltip, never below it. */
  hint?: string;
  /** Skips the top rule when this is the first thing in the card. */
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={first ? "space-y-3" : "space-y-3 border-t border-border pt-5"}
    >
      <p className="flex w-fit items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {hint && <InfoTip content={hint} />}
      </p>
      {children}
    </div>
  );
}
