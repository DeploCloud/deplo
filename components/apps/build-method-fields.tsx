"use client";

import * as React from "react";
import { FileCode2, Boxes, Layers, FileText, RotateCcw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RailpackVersionInput } from "@/components/apps/railpack-version-input";
import { FrameworkIcon } from "@/components/shared/framework-icons";
import {
  FRAMEWORKS,
  frameworkById,
  supportsFrameworkDetection,
} from "@/lib/apps/framework-catalog";
import { cn } from "@/lib/utils";
import type { BuildMethod, BuildMethodSettings } from "@/lib/types";

interface MethodMeta {
  id: BuildMethod;
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
}

/** The selectable build methods, in the order shown in the picker. */
export const BUILD_METHODS: MethodMeta[] = [
  {
    id: "nixpacks",
    name: "Nixpacks",
    icon: Boxes,
    blurb: "Zero-config builder that detects and builds your app.",
  },
  {
    id: "railpack",
    name: "Railpack",
    icon: Layers,
    blurb: "Railway's BuildKit-based builder. Auto-detects your stack.",
  },
  {
    id: "dockerfile",
    name: "Dockerfile",
    icon: FileCode2,
    blurb: "Build straight from a Dockerfile in your repository.",
  },
  {
    id: "static",
    name: "Static",
    icon: FileText,
    blurb: "Serve a directory of files as a static site behind nginx.",
  },
];

/**
 * Per-method build settings. Renders the method picker (a radio group of cards)
 * plus a panel with only the fields the selected method actually uses. Driven by
 * the parent's BuildConfig state.
 */
export function BuildMethodFields({
  method,
  settings,
  onMethodChange,
  onSettingsChange,
  framework,
  detectedFramework,
  onFrameworkChange,
}: {
  method: BuildMethod;
  settings: BuildMethodSettings;
  onMethodChange: (m: BuildMethod) => void;
  onSettingsChange: (patch: Partial<BuildMethodSettings>) => void;
  /**
   * The framework in force — the user's correction if they made one, else what
   * the last deploy read. Shown as the first setting of the auto-detecting
   * builders' options panel, because that is whose setting it is: only Nixpacks
   * and Railpack read the source and act on what they find.
   */
  framework?: string | null;
  /** What DETECTION found, so the field can say whose answer is showing. */
  detectedFramework?: string | null;
  /** Correct it (null ⇒ back to detection). Omitted ⇒ no framework field at all,
   * which is what a caller with no source to read (the create wizard) wants. */
  onFrameworkChange?: (id: string | null) => void;
}) {
  return (
    <div className="space-y-4">
      {/* No heading of its own: the caller titles this group, and two "Build
          method" labels stacked on each other is noise. */}
      <div
        role="radiogroup"
        aria-label="Build method"
        className="grid gap-2 sm:grid-cols-2"
      >
        {BUILD_METHODS.map((m) => (
          <MethodCard
            key={m.id}
            meta={m}
            selected={m.id === method}
            onSelect={() => onMethodChange(m.id)}
          />
        ))}
      </div>

      <MethodSettings
        method={method}
        settings={settings}
        onSettingsChange={onSettingsChange}
        framework={framework}
        detectedFramework={detectedFramework}
        onFrameworkChange={onFrameworkChange}
      />
    </div>
  );
}

/** One selectable build-method card: icon, name, blurb, and a radio indicator. */
function MethodCard({
  meta,
  selected,
  onSelect,
}: {
  meta: MethodMeta;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = meta.icon;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-primary/[0.06] ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20 hover:bg-muted/40",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors",
          selected
            ? "border-primary/40 bg-background text-primary"
            : "border-border bg-muted/50 text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{meta.name}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
          {meta.blurb}
        </span>
      </span>
      {/* Radio dot — the unambiguous "this one is selected" cue. */}
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-primary" : "border-muted-foreground/40",
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
    </button>
  );
}

/**
 * The selected method's own settings, grouped into a labelled panel so it reads as
 * "the {method} configuration" rather than loose fields under the picker. Every
 * method has at least one setting, so the panel always renders.
 *
 * The framework leads that panel where it applies. It is not a step of its own:
 * "which framework is this" is a question only the auto-detecting builders ask,
 * and the answer only ever changes what THEY do — so it belongs among their
 * options, not floating above the method that owns it.
 */
function MethodSettings({
  method,
  settings,
  onSettingsChange,
  framework,
  detectedFramework,
  onFrameworkChange,
}: {
  method: BuildMethod;
  settings: BuildMethodSettings;
  onSettingsChange: (patch: Partial<BuildMethodSettings>) => void;
  framework?: string | null;
  detectedFramework?: string | null;
  onFrameworkChange?: (id: string | null) => void;
}) {
  const meta = BUILD_METHODS.find((m) => m.id === method);
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {meta.name} options
      </div>

      {onFrameworkChange && supportsFrameworkDetection(method) && (
        <FrameworkField
          framework={framework ?? null}
          detected={detectedFramework ?? null}
          onChange={onFrameworkChange}
        />
      )}

      {method === "dockerfile" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Dockerfile path"
            placeholder="Dockerfile"
            value={settings.dockerfilePath ?? ""}
            onChange={(v) => onSettingsChange({ dockerfilePath: v })}
            help="Path to the Dockerfile, relative to the repo root."
          />
          <TextField
            label="Build context path"
            placeholder="."
            value={settings.dockerContextPath ?? ""}
            onChange={(v) => onSettingsChange({ dockerContextPath: v })}
            help="Directory sent to the Docker build, relative to the repo root."
          />
          <TextField
            label="Build stage (target)"
            placeholder="(final stage)"
            value={settings.dockerBuildStage ?? ""}
            onChange={(v) => onSettingsChange({ dockerBuildStage: v })}
            help="Optional --target stage in a multi-stage Dockerfile."
          />
        </div>
      )}

      {method === "railpack" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <FieldLabel
              info={
                <>
                  Builder version, kept in sync with the railpack releases. Pick{" "}
                  <code className="font-mono">latest</code> or a specific tag.
                </>
              }
            >
              Railpack version
            </FieldLabel>
            <RailpackVersionInput
              value={settings.railpackVersion ?? ""}
              onChange={(v) => onSettingsChange({ railpackVersion: v })}
            />
          </div>
        </div>
      )}

      {method === "nixpacks" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Publish directory"
            placeholder="(auto)"
            value={settings.nixpacksPublishDirectory ?? ""}
            onChange={(v) => onSettingsChange({ nixpacksPublishDirectory: v })}
            help="After the build finishes, serve just this directory as a static site through NGINX — handy when your build emits static assets to publish. Leave blank to run the app normally."
          />
        </div>
      )}

      {method === "static" && (
        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            checked={settings.staticSinglePageApp ?? false}
            onCheckedChange={(v) =>
              onSettingsChange({ staticSinglePageApp: v === true })
            }
            className="mt-0.5"
          />
          <span>
            <span className="text-sm font-medium">Single-page application</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Route unknown paths to index.html so client-side routing works
              (history-API fallback).
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

/** The Select's stand-in for "no override" — Radix cannot hold an empty value. */
const AUTO = "__auto";

/** The frameworks a user picks from, by display name — a picker is searched
 * alphabetically, unlike the catalog's detection-priority order. */
const FRAMEWORK_CHOICES = [...FRAMEWORKS].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/**
 * Which framework the builder should treat this app as.
 *
 * Detection is a heuristic over a `package.json` and where it is wrong it is
 * wrong about the container PORT (`vite preview` binds 4173 and ignores PORT),
 * so the answer has to be correctable — with what deplo actually detected still
 * visible next to the correction, and a one-click way back to it.
 */
function FrameworkField({
  framework,
  detected,
  onChange,
}: {
  framework: string | null;
  detected: string | null;
  onChange: (id: string | null) => void;
}) {
  const current = frameworkById(framework);
  const detectedDef = frameworkById(detected);
  const overridden = framework != null && framework !== detected;

  return (
    <div className="mb-4 space-y-2">
      <FieldLabel
        info={
          <>
            deplo reads your source on every deploy and names the framework
            itself. Change it only when it got that wrong — the pick sticks
            through later deploys and sets the container port that framework&apos;s
            server binds.
          </>
        }
      >
        Framework
      </FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={framework ?? AUTO}
          onValueChange={(v) => onChange(v === AUTO ? null : v)}
        >
          <SelectTrigger className="w-full max-w-xs">
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
        {overridden && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onChange(null)}
          >
            <RotateCcw className="size-3.5" />
            {detectedDef ? `Use detected (${detectedDef.name})` : "Back to automatic"}
          </Button>
        )}
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        {overridden ? (
          detectedDef ? (
            <>Your choice, kept through every deploy — deplo detected {detectedDef.name}.</>
          ) : (
            <>Your choice, kept through every deploy — deplo didn&apos;t recognise a framework.</>
          )
        ) : current ? (
          <>Read from your source on the last deploy, and re-checked on every one.</>
        ) : (
          <>
            Nothing recognised yet. Pick one if you already know — otherwise the
            next deploy names it.
          </>
        )}
      </p>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  help?: string;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel info={help}>{label}</FieldLabel>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
      />
    </div>
  );
}
