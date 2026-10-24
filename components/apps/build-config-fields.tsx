"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { BuildMethodFields } from "@/components/apps/build-method-fields";
import { NodeVersionInput } from "@/components/apps/node-version-input";
import {
  buildsWithRailpack,
  methodChoice,
  withMethodChoice,
} from "@/lib/apps/build-method";
import type { BuildConfig, BuildMethodSettings } from "@/lib/types/build";

export function BuildConfigFields({
  build,
  onBuildChange,
  commands = true,
}: {
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
  commands?: boolean;
}) {
  function setBuild(updater: (b: BuildConfig) => BuildConfig) {
    onBuildChange(updater(build));
  }

  function patchMethodSettings(patch: Partial<BuildMethodSettings>) {
    setBuild((b) => ({
      ...b,
      methodSettings: { ...b.methodSettings, ...patch },
    }));
  }

  const method = methodChoice(build);
  const railpack = buildsWithRailpack(method);
  // A compose stack's port is the routed service's, not one for the whole app.
  const showPort = method !== "compose";

  const [portDraft, setPortDraft] = React.useState<string | null>(null);
  const portText = portDraft ?? String(build.port);

  function onPortChange(text: string) {
    setPortDraft(text);
    const n = Number(text);
    if (text.trim() !== "" && Number.isInteger(n) && n > 0) {
      setBuild((b) => ({ ...b, port: n }));
    }
  }

  function onPortBlur() {
    setPortDraft(null);
  }

  return (
    <div className="space-y-5">
      <FieldGroup title="Build method" first>
        <BuildMethodFields
          method={method}
          settings={build.methodSettings}
          onMethodChange={(m) => setBuild((b) => withMethodChoice(b, m))}
          onSettingsChange={patchMethodSettings}
        />
      </FieldGroup>

      {commands && railpack && (
        <FieldGroup
          title="Commands"
          hint="Leave blank to let the builder work them out from your code."
        >
          <div className="grid gap-4 sm:grid-cols-2">
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
          </div>
        </FieldGroup>
      )}

      {(railpack || showPort) && (
        <FieldGroup title="Runtime">
          <div className="grid gap-4 sm:grid-cols-2">
            {railpack && (
              <div className="space-y-2">
                <FieldLabel
                  info="Pins the Node.js major, kept in sync with the real Node releases. Leave blank to read it from your project."
                  docs="build.fields"
                >
                  Node.js version
                </FieldLabel>
                <NodeVersionInput
                  value={build.runtimeVersion}
                  onChange={(v) =>
                    setBuild((b) => ({ ...b, runtimeVersion: v }))
                  }
                  placeholder="Default (auto-detect)"
                />
              </div>
            )}

            {showPort && (
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
            )}
          </div>
        </FieldGroup>
      )}
    </div>
  );
}

function FieldGroup({
  title,
  hint,
  first,
  children,
}: {
  title: string;
  hint?: string;
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
