"use client";

import * as React from "react";
import { RotateCcw, Search, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/info-tip";
import { BuildMethodFields } from "@/components/apps/build-method-fields";
import { NodeVersionInput } from "@/components/apps/node-version-input";
import { FrameworkIcon } from "@/components/shared/framework-icons";
import {
  FRAMEWORKS,
  frameworkById,
  supportsFrameworkDetection,
} from "@/lib/apps/framework-catalog";
import { DEFAULT_NODE_MAJOR, usesDefaultNodeMajor } from "@/lib/frameworks";
import type {
  BuildConfig,
  BuildMethod,
  BuildMethodSettings,
} from "@/lib/types";

/**
 * The build-method-aware "Build & Output" section shared by the new-project
 * wizard and the app settings form, so the two stay in sync.
 *
 * Owns no persistence: the parent holds the BuildConfig and decides how/when to
 * save it. Four groups, in the order the questions actually get asked —
 * Framework (what is this app?), Build method (how is the image made?), Commands
 * (what runs during the build?), Runtime & networking (how does it come up?) —
 * so no field floats without a heading explaining which question it answers.
 */
export function BuildConfigFields({
  build,
  onBuildChange,
  framework,
  detectedFramework,
  onFrameworkChange,
}: {
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
  /**
   * The framework this app is treated as — the user's correction if they made
   * one, else what the last deploy read. Only shown under a build method
   * recognition applies to, so switching to a Dockerfile drops the whole group
   * with the feature. Absent ⇒ the group is hidden, which is what a caller with
   * no source to read (the create wizard) passes.
   */
  framework?: string | null;
  /** What DETECTION found, so the group can say whether `framework` is Deplo's
   * answer or the user's, and offer the way back. */
  detectedFramework?: string | null;
  /**
   * Correct the framework (null ⇒ go back to detection). Omitted ⇒ the group is
   * read-only, showing what Deplo recognised with no way to change it.
   */
  onFrameworkChange?: (id: string | null) => void;
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
  // a port set from OUTSIDE (framework recognition picking the port that
  // framework's server binds) appear immediately, while a draft in progress keeps
  // the user's own text until they leave the field.
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

  /**
   * Correcting the framework carries the container port with it — that is the
   * whole reason the setting is worth having (`vite preview` binds 4173 and
   * ignores PORT, so an app mis-read as Next.js deploys green and answers
   * nothing). Only when the port is still the OUTGOING framework's default,
   * though: a port the user typed themselves is an answer, not a leftover.
   *
   * Clearing the correction (`next === null`) hands the port back to DETECTION's
   * framework, not to nothing — otherwise "use what Deplo detected" would undo
   * the name and leave the wrong port behind, which is the whole failure this
   * setting exists to fix.
   */
  function pickFramework(next: string | null) {
    const previousPort = frameworkById(framework)?.defaultPort ?? 3000;
    const nextPort = frameworkById(next ?? detectedFramework)?.defaultPort;
    if (nextPort && build.port === previousPort) {
      setPortDraft(null);
      setBuild((b) => ({ ...b, port: nextPort }));
    }
    onFrameworkChange?.(next);
  }

  const frameworkVisible =
    supportsFrameworkDetection(method) &&
    (framework != null || onFrameworkChange != null);

  return (
    <div className="space-y-5">
      {frameworkVisible && (
        <FrameworkGroup
          framework={framework ?? null}
          detected={detectedFramework ?? null}
          onChange={onFrameworkChange ? pickFramework : undefined}
        />
      )}

      <FieldGroup title="Build method" first={!frameworkVisible}>
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

/** The frameworks a user can pick from, by display name — a picker is searched
 * alphabetically, unlike the catalog's detection-priority order. */
const FRAMEWORK_CHOICES = [...FRAMEWORKS].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/** The Select's stand-in for "no override" — Radix cannot hold an empty value. */
const AUTO = "__auto";

/**
 * The framework group: the platform's "we know what this is" moment, and the
 * one control that lets the user say otherwise.
 *
 * It gets the most space in the card on purpose. Detection is a heuristic over a
 * `package.json`, and where it is wrong it is wrong about the container PORT —
 * so the answer has to be both prominent and correctable, with what Deplo
 * detected still visible next to the correction.
 */
function FrameworkGroup({
  framework,
  detected,
  onChange,
}: {
  framework: string | null;
  detected: string | null;
  onChange?: (id: string | null) => void;
}) {
  const current = frameworkById(framework);
  const detectedDef = frameworkById(detected);
  const overridden = framework != null && framework !== detected;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
          {current ? (
            <FrameworkIcon id={current.id} className="size-6" />
          ) : (
            <Search className="size-5 text-muted-foreground" />
          )}
        </span>

        <div className="min-w-0 flex-1 space-y-2">
          <FieldLabel
            info={
              <>
                Deplo reads your source on every deploy and names the framework
                itself. Change it only when it got that wrong — the pick sticks
                through later deploys and sets the container port that
                framework&apos;s server binds.
              </>
            }
          >
            Framework
          </FieldLabel>

          {onChange ? (
            <Select
              value={framework ?? AUTO}
              onValueChange={(v) => onChange(v === AUTO ? null : v)}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>
                  <span className="flex items-center gap-2">
                    <Wand2 className="size-4 text-muted-foreground" />
                    Detect automatically
                  </span>
                </SelectItem>
                {FRAMEWORK_CHOICES.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    <span className="flex items-center gap-2">
                      <FrameworkIcon id={f.id} className="size-4" />
                      {f.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm font-medium">
              {current?.name ?? "Not recognised yet"}
            </p>
          )}

          <p className="text-xs leading-snug text-muted-foreground">
            {overridden ? (
              <>
                Your choice, kept through every deploy.{" "}
                {detectedDef
                  ? `Deplo detected ${detectedDef.name} in your source.`
                  : "Deplo didn't recognise a framework in your source."}
              </>
            ) : current ? (
              <>
                Detected in your source on the last deploy. Deplo re-checks on
                every one.
              </>
            ) : (
              <>
                Nothing recognised in your source yet. Pick one if you already
                know — otherwise the next deploy names it.
              </>
            )}
          </p>

          {overridden && onChange && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 h-7 text-xs"
              onClick={() => onChange(null)}
            >
              <RotateCcw className="size-3.5" />
              {detectedDef
                ? `Use detected (${detectedDef.name})`
                : "Back to automatic"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
