"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
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
 *
 * Owns no persistence: the parent holds the BuildConfig and decides how/when to
 * save it. The app's settings page does NOT use this — it lays the same
 * configuration out as a pipeline (`settings/build-output-card.tsx`), where a
 * deployed app can also correct the framework deplo detected. Nothing to correct
 * here: the wizard runs before the first deploy has read anything.
 */
export function BuildConfigFields({
  build,
  onBuildChange,
}: {
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
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
  // auto-detecting builders. Show each only where the deploy path (agent-side
  // builders) actually consumes it, so a field never silently does nothing:
  //  - nixpacks: build (-b) + start (-s) commands + Node (NIXPACKS_NODE_VERSION)
  //  - railpack: build + start commands + Node (RAILPACK_{BUILD,START}_CMD / _NODE_VERSION)
  //  - static:   build command (produces the assets) + Node (the builder stage).
  //              No start command — nginx serves the output, there is no app process.
  //  - dockerfile: none — the repo's Dockerfile owns install/build/run.
  const method = build.buildMethod;
  const showBuildCommand =
    method === "nixpacks" || method === "railpack" || method === "static";
  const showStartCommand = method === "nixpacks" || method === "railpack";
  const showNodeVersion =
    method === "nixpacks" || method === "railpack" || method === "static";
  const showCommands = showBuildCommand || showStartCommand;

  // The port field keeps a DRAFT of what is typed so it can be emptied mid-edit.
  // Only a valid positive integer is committed to the build config; while the
  // field is blank/invalid the last committed port stays put (so clearing it to
  // type a new number no longer snaps the default straight back).
  //
  // `null` means "no draft — show the committed port", which is also what makes
  // a port set from OUTSIDE (the wizard seeding the framework's own port) appear
  // immediately, while a draft in progress keeps the user's own text until they
  // leave the field.
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
   * again — which is what restores it after it was emptied or left invalid. */
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
                <FieldLabel info="Overrides the command that builds your app. Leave blank to let the builder detect it.">
                  Build command
                </FieldLabel>
                <Input
                  className="font-mono text-xs"
                  placeholder="(auto-detected)"
                  value={build.buildCommand}
                  onChange={(e) =>
                    setBuild((b) => ({ ...b, buildCommand: e.target.value }))
                  }
                />
              </div>
            )}

            {showStartCommand && (
              <div className="space-y-2">
                <FieldLabel info="Overrides the command that starts your app inside the container.">
                  Start command
                </FieldLabel>
                <Input
                  className="font-mono text-xs"
                  placeholder="(auto-detected)"
                  value={build.startCommand}
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
            <FieldLabel info="The port your app listens on inside the container (Traefik routes here).">
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
  hint?: string;
  /** Skips the top rule when this is the first thing in the card. */
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={first ? "space-y-3" : "space-y-3 border-t border-border pt-5"}>
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        {hint && <p className="text-xs text-muted-foreground/80">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
