"use client";

import * as React from "react";
import { Hammer, Play, Save, Terminal, Webhook } from "lucide-react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { BuildMethodFields } from "@/components/apps/build-method-fields";
import { NodeVersionInput } from "@/components/apps/node-version-input";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { frameworkById } from "@/lib/apps/framework-catalog";
import { DEFAULT_NODE_MAJOR, usesDefaultNodeMajor } from "@/lib/frameworks";
import { cn } from "@/lib/utils";
import type {
  BuildConfig,
  BuildMethod,
  BuildMethodSettings,
} from "@/lib/types";

/**
 * Build & Output - the card that answers "what happens between my code and a
 * running container", laid out as the PIPELINE it actually is. The rail never
 * shows a control that would do nothing.
 */
export function BuildOutputCard({
  build,
  onBuildChange,
  framework,
  detectedFramework,
  onFrameworkChange,
  autoDeploy,
  onAutoDeployChange,
  autoDeployBranch,
  showAutoDeploy,
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
  autoDeploy: boolean;
  onAutoDeployChange: (value: boolean) => void;
  /** The branch pushes are watched on, for the Deploy-on-push copy. */
  autoDeployBranch: string;
  /**
   * Whether deploy-on-push means anything for this app.
   */
  showAutoDeploy: boolean;
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
  const showBuildStage = showBuildCommand || showNodeVersion;

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
          Build &amp; Output
          <InfoTip
            content="Every stage between your code and a running container - how the image is built, what runs during the build, and how it comes up."
            docs="build.methods"
          />
        </CardTitle>
      </CardHeader>

      <CardContent>
        <div>
          <Stage
            marker={<Hammer className="size-4" />}
            title="Builder"
            hint="How the container image is made from your source."
          >
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
              // options panel rather than as a stage of its own.
              framework={framework}
              detectedFramework={detectedFramework}
              onFrameworkChange={pickFramework}
            />
          </Stage>

          {showBuildStage && (
            <Stage
              marker={<Terminal className="size-4" />}
              title="Build"
              hint="What runs while the image is built. Leave blank to let the builder work it out from your code."
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
                      value={build.buildCommand}
                      onChange={(e) =>
                        setBuild((b) => ({
                          ...b,
                          buildCommand: e.target.value,
                        }))
                      }
                    />
                  </div>
                )}
                {showNodeVersion && (
                  <div className="space-y-2">
                    <FieldLabel
                      info={
                        <>
                          Pins the Node.js major, kept in sync with the real
                          Node releases.
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
                      onChange={(v) =>
                        setBuild((b) => ({ ...b, runtimeVersion: v }))
                      }
                      placeholder={
                        usesDefaultNodeMajor(method)
                          ? `Default (Node ${DEFAULT_NODE_MAJOR})`
                          : "Default (auto-detect)"
                      }
                    />
                  </div>
                )}
              </div>
            </Stage>
          )}

          <Stage
            marker={<Play className="size-4" />}
            title="Run"
            hint={
              showStartCommand
                ? "How the container comes up, and the port deplo routes traffic to."
                : "The port deplo routes traffic to inside the container."
            }
            last={!showAutoDeploy}
          >
            <div className="grid gap-4 sm:grid-cols-2">
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
                    value={build.startCommand}
                    onChange={(e) =>
                      setBuild((b) => ({ ...b, startCommand: e.target.value }))
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
                  // Dropping the draft on blur shows the committed port again,
                  // which is what restores it after it was emptied.
                  onBlur={() => setPortDraft(null)}
                />
              </div>
            </div>
          </Stage>

          {showAutoDeploy && (
            <Stage
              marker={<Webhook className="size-4" />}
              title="Deploy on push"
              hint={
                <>
                  Run everything above again on every push to{" "}
                  <code className="font-mono text-[0.7rem]">
                    {autoDeployBranch}
                  </code>
                  .
                </>
              }
              action={
                <Switch
                  checked={autoDeploy}
                  onCheckedChange={onAutoDeployChange}
                  disabled={pending}
                  aria-label="Deploy on push"
                />
              }
              last
            />
          )}
        </div>
      </CardContent>

      <CardFooter className="justify-between border-t border-border pt-4">
        <DirtyHint dirty={dirty} />
        <Button size="sm" onClick={onSave} disabled={pending || !dirty}>
          <Save className="size-4" />
          Save build settings
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * One stage of the pipeline: a marker on the rail, a title, a line saying what
 * happens here, and the fields that steer it. The connector is drawn by every
 * stage except the last, so the rail ends exactly where the pipeline does.
 */
function Stage({
  marker,
  title,
  hint,
  action,
  children,
  last = false,
}: {
  marker: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  /** Right-aligned control on the title row (a switch), for stages whose whole
   * setting IS one control. */
  action?: React.ReactNode;
  children?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className="relative grid grid-cols-[1.75rem_1fr] gap-x-4">
      {!last && (
        <span
          aria-hidden
          className="absolute top-8 bottom-0 left-[0.875rem] w-px -translate-x-1/2 bg-border"
        />
      )}
      <span className="relative z-10 mt-0.5 flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
        {marker}
      </span>
      <div className={cn("min-w-0", !last && "pb-6")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium">{title}</p>
            {hint && (
              <p className="text-xs leading-snug text-muted-foreground">
                {hint}
              </p>
            )}
          </div>
          {action}
        </div>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </div>
  );
}
