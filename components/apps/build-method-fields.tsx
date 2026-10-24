"use client";

import * as React from "react";
import { Boxes, FileCode2, RotateCcw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import type { DocsTopic } from "@/lib/docs";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SegmentedTabsList,
  SegmentedTabsTrigger,
  Tabs,
} from "@/components/ui/tabs";
import { Combobox } from "@/components/shared/combobox";
import { FrameworkIcon } from "@/components/shared/framework-icons";
import {
  FRAMEWORKS,
  frameworkById,
  supportsFrameworkDetection,
  type FrameworkId,
} from "@/lib/apps/framework-catalog";
import {
  buildsWithRailpack,
  type BuildMethodChoice,
} from "@/lib/apps/build-method";
import { cn } from "@/lib/utils";
import type { BuildMethod, BuildMethodSettings } from "@/lib/types/build";

// Railpack has no tab of its own: it is Automatic with the file check off (RailpackOptions).
const METHOD_TABS = [
  { id: "auto", name: "Automatic", icon: Wand2 },
  { id: "dockerfile", name: "Dockerfile", icon: FileCode2 },
  { id: "compose", name: "Compose", icon: Boxes },
] as const;

const METHOD_NAMES: Record<BuildMethod, string> = {
  railpack: "Railpack",
  dockerfile: "Dockerfile",
  compose: "Docker Compose",
};

const METHOD_LINES: Record<BuildMethodChoice, string> = {
  auto: "Uses your Dockerfile or Compose file if you have one, otherwise builds your code directly.",
  railpack:
    "Builds your code directly, even when it has a Dockerfile or Compose file.",
  dockerfile: "Builds from the Dockerfile in your code.",
  compose: "Runs the services in your Compose file.",
};

export function BuildMethodFields({
  method,
  settings,
  onMethodChange,
  onSettingsChange,
  lastBuiltWith,
  framework,
  detectedFramework,
  onFrameworkChange,
  children,
}: {
  method: BuildMethodChoice;
  settings: BuildMethodSettings;
  onMethodChange: (m: BuildMethodChoice) => void;
  onSettingsChange: (patch: Partial<BuildMethodSettings>) => void;
  lastBuiltWith?: BuildMethod | null;
  framework?: string | null;
  detectedFramework?: string | null;
  onFrameworkChange?: (id: string | null) => void;
  children?: React.ReactNode;
}) {
  const showFramework =
    onFrameworkChange != null && supportsFrameworkDetection(method);
  const hasFields =
    showFramework ||
    !buildsWithRailpack(method) ||
    React.Children.toArray(children).length > 0;

  const fields = (
    <>
      {showFramework && onFrameworkChange && (
        <FrameworkField
          framework={framework ?? null}
          detected={detectedFramework ?? null}
          onChange={onFrameworkChange}
        />
      )}

      {method === "dockerfile" && (
        <>
          <TextField
            label="Dockerfile path"
            placeholder="Dockerfile"
            value={settings.dockerfilePath ?? ""}
            onChange={(v) => onSettingsChange({ dockerfilePath: v })}
            help="Relative to the repository root."
          />
          <TextField
            label="Build context"
            placeholder="."
            value={settings.dockerContextPath ?? ""}
            onChange={(v) => onSettingsChange({ dockerContextPath: v })}
            help="The folder the build can read, relative to the repository root."
          />
          <TextField
            label="Build stage"
            placeholder="last stage"
            value={settings.dockerBuildStage ?? ""}
            onChange={(v) => onSettingsChange({ dockerBuildStage: v })}
            help="The stage to build in a multi-stage Dockerfile."
          />
        </>
      )}

      {method === "compose" && (
        <TextField
          label="Compose file"
          placeholder="docker-compose.yml"
          value={settings.composeFile ?? ""}
          onChange={(v) => onSettingsChange({ composeFile: v })}
          help="Path in your repository. Empty finds compose.yaml, compose.yml, docker-compose.yaml or docker-compose.yml."
          className="sm:col-span-2"
        />
      )}

      {children}
    </>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Tabs
          value={method === "railpack" ? "auto" : method}
          onValueChange={(v) => onMethodChange(v as BuildMethodChoice)}
        >
          <SegmentedTabsList aria-label="Build method">
            {METHOD_TABS.map(({ id, name, icon: Icon }) => (
              <SegmentedTabsTrigger
                key={id}
                value={id}
                className="max-sm:[&_svg]:hidden"
              >
                <Icon />
                {name}
              </SegmentedTabsTrigger>
            ))}
          </SegmentedTabsList>
        </Tabs>
        <p className="text-xs text-muted-foreground">
          {METHOD_LINES[method]}
          {method === "auto" && lastBuiltWith && (
            <>
              {" "}
              Last deploy:{" "}
              <span className="text-foreground">
                {METHOD_NAMES[lastBuiltWith]}
              </span>
              .
            </>
          )}
        </p>
      </div>

      {hasFields && <div className="grid gap-4 sm:grid-cols-2">{fields}</div>}
    </div>
  );
}

export function RailpackOptions({
  method,
  settings,
  onMethodChange,
  onSettingsChange,
}: {
  method: BuildMethodChoice;
  settings: BuildMethodSettings;
  onMethodChange: (m: BuildMethodChoice) => void;
  onSettingsChange: (patch: Partial<BuildMethodSettings>) => void;
}) {
  if (!buildsWithRailpack(method)) return null;
  return (
    <div className="space-y-3">
      <CheckField
        id="single-page-app"
        checked={settings.staticSinglePageApp ?? false}
        onChange={(v) => onSettingsChange({ staticSinglePageApp: v })}
        info="Sends every unknown path to index.html, so client-side routing works."
      >
        Single-page application
      </CheckField>
      <CheckField
        id="always-railpack"
        checked={method === "railpack"}
        onChange={(v) => onMethodChange(v ? "railpack" : "auto")}
        info="Skips your Dockerfile and Compose file, even when your code has one."
        docs="build.methods"
      >
        Always build with Railpack
      </CheckField>
    </div>
  );
}

function CheckField({
  id,
  checked,
  onChange,
  info,
  docs,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  info: string;
  docs?: DocsTopic;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <FieldLabel htmlFor={id} info={info} docs={docs}>
        {children}
      </FieldLabel>
    </div>
  );
}

const AUTO = "__auto";

const FRAMEWORK_CHOICES = [
  { id: AUTO, name: "Detect automatically" },
  ...[...FRAMEWORKS].sort((a, b) => a.name.localeCompare(b.name)),
];

const frameworkMark = (id: string) =>
  id === AUTO ? (
    <Wand2 className="size-4 text-muted-foreground" />
  ) : (
    <FrameworkIcon id={id as FrameworkId} className="size-4" />
  );

function FrameworkField({
  framework,
  detected,
  onChange,
}: {
  framework: string | null;
  detected: string | null;
  onChange: (id: string | null) => void;
}) {
  const detectedDef = frameworkById(detected);
  const overridden = framework != null && framework !== detected;

  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor="framework"
        info="Detected on every deploy. Pick one only if Deplo got it wrong: it also sets the port."
        docs="build.methods"
      >
        Framework
      </FieldLabel>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Combobox
            id="framework"
            items={FRAMEWORK_CHOICES}
            value={framework ?? AUTO}
            onChange={(id) => onChange(id === AUTO ? null : id)}
            getKey={(f) => f.id}
            matches={(f, q) => f.name.toLowerCase().includes(q)}
            displayValue={(f) => f.name}
            renderLeading={(f) => frameworkMark(f.id)}
            renderOption={(f) => (
              <span className="flex items-center gap-2 text-sm">
                {frameworkMark(f.id)}
                {f.name}
              </span>
            )}
            placeholder="Detect automatically"
            searchPlaceholder="Search frameworks"
            emptyLabel={() => "No framework matches that"}
          />
        </div>
        {overridden && (
          <Button
            type="button"
            variant="ghost"
            className="shrink-0"
            onClick={() => onChange(null)}
          >
            <RotateCcw className="size-3.5" />
            {detectedDef ? `Use ${detectedDef.name}` : "Reset"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  help,
  docs,
  disabled,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  help?: string;
  docs?: DocsTopic;
  disabled?: boolean;
  className?: string;
}) {
  const id = React.useId();
  return (
    <div className={cn("space-y-2", className)}>
      <FieldLabel htmlFor={id} info={help} docs={docs}>
        {label}
      </FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
      />
    </div>
  );
}
