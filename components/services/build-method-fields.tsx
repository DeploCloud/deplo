"use client";

import * as React from "react";
import { FileCode2, Boxes, Layers, FileText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Build Method</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {BUILD_METHODS.map((m) => {
            const Icon = m.icon;
            const selected = m.id === method;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onMethodChange(m.id)}
                aria-pressed={selected}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  selected
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:border-foreground/20 hover:bg-muted/40",
                )}
              >
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-md border",
                    selected
                      ? "border-primary/40 bg-background text-foreground"
                      : "border-border bg-muted/50 text-muted-foreground",
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{m.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {m.blurb}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
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
            <Label>Railpack version</Label>
            <RailpackVersionInput
              value={settings.railpackVersion ?? ""}
              onChange={(v) => onSettingsChange({ railpackVersion: v })}
            />
            <p className="text-xs text-muted-foreground">
              Builder version, kept in sync with the railpack releases. Pick{" "}
              <code className="font-mono">latest</code> or a specific tag.
            </p>
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
