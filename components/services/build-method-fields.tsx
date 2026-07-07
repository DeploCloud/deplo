"use client";

import * as React from "react";
import {
  FileCode2,
  Boxes,
  Layers,
  Hexagon,
  Package,
  FileText,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import type { BuildMethod, BuildMethodSettings } from "@/lib/types";

interface MethodMeta {
  id: BuildMethod;
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
}

/** The six selectable build methods, in the order shown in the picker. */
export const BUILD_METHODS: MethodMeta[] = [
  {
    id: "dockerfile",
    name: "Dockerfile",
    icon: FileCode2,
    blurb: "Build straight from a Dockerfile in your repository.",
  },
  {
    id: "railpack",
    name: "Railpack",
    icon: Layers,
    blurb: "Railway's BuildKit-based builder. Auto-detects your stack.",
  },
  {
    id: "nixpacks",
    name: "Nixpacks",
    icon: Boxes,
    blurb: "Zero-config builder that detects and builds your app.",
  },
  {
    id: "heroku",
    name: "Heroku Buildpacks",
    icon: Hexagon,
    blurb: "Cloud Native Buildpacks using the Heroku builder.",
  },
  {
    id: "paketo",
    name: "Paketo Buildpacks",
    icon: Package,
    blurb: "Cloud Native Buildpacks using the Paketo builder.",
  },
  {
    id: "static",
    name: "Static",
    icon: FileText,
    blurb: "Serve your build output as a static site behind nginx.",
  },
];

/**
 * Per-method build settings. Renders the picker grid plus only the fields the
 * selected method actually uses. Driven by the parent's BuildConfig state.
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
  const active = BUILD_METHODS.find((m) => m.id === method) ?? BUILD_METHODS[2];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Build Method</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {BUILD_METHODS.map((m) => {
            const Icon = m.icon;
            const selected = m.id === method;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onMethodChange(m.id)}
                aria-pressed={selected}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{m.name}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{active.blurb}</p>
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
          <TextField
            label="Railpack version"
            placeholder="latest"
            value={settings.railpackVersion ?? ""}
            onChange={(v) => onSettingsChange({ railpackVersion: v })}
            help="Railpack builder image tag (e.g. latest, 0.7)."
          />
        </div>
      )}

      {method === "nixpacks" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Publish directory"
            placeholder="(auto)"
            value={settings.nixpacksPublishDirectory ?? ""}
            onChange={(v) => onSettingsChange({ nixpacksPublishDirectory: v })}
            help="Directory your build publishes. Leave blank to let Nixpacks decide."
          />
        </div>
      )}

      {method === "heroku" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Builder version"
            placeholder="24"
            value={settings.herokuVersion ?? ""}
            onChange={(v) => onSettingsChange({ herokuVersion: v })}
            help="Heroku builder tag, mapped to heroku/builder:<version>."
          />
        </div>
      )}

      {method === "paketo" && (
        <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
          Builds with the Paketo Jammy base builder. No extra configuration
          required.
        </p>
      )}

      {method === "static" && (
        <label className="flex items-start gap-3 rounded-lg border border-border p-3">
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
      <Label>{label}</Label>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
      />
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}
