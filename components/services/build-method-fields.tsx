"use client";

import * as React from "react";
import { FileCode2, Boxes, Layers, FileText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { Checkbox } from "@/components/ui/checkbox";
import { RailpackVersionInput } from "@/components/services/railpack-version-input";
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
}: {
  method: BuildMethod;
  settings: BuildMethodSettings;
  onMethodChange: (m: BuildMethod) => void;
  onSettingsChange: (patch: Partial<BuildMethodSettings>) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Build Method</Label>
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
      </div>

      <MethodSettings
        method={method}
        settings={settings}
        onSettingsChange={onSettingsChange}
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
 */
function MethodSettings({
  method,
  settings,
  onSettingsChange,
}: {
  method: BuildMethod;
  settings: BuildMethodSettings;
  onSettingsChange: (patch: Partial<BuildMethodSettings>) => void;
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
            <span className="block text-xs text-muted-foreground">
              Route unknown paths to index.html so client-side routing works
              (history-API fallback).
            </span>
          </span>
        </label>
      )}
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
