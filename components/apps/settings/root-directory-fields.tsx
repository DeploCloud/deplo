"use client";

import { FolderTree } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import type { BuildConfig } from "@/lib/types";

/**
 * The "Root Directory" section: which sub-path of the repo the build runs from.
 */
export function RootDirectoryFields({
  build,
  onBuildChange,
  disabled,
  bare = false,
}: {
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
  disabled?: boolean;
  /** Just the field: the caller's row already carries the label. */
  bare?: boolean;
}) {
  const field = (
    <div className="relative max-w-md">
      <FolderTree className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id="root-directory"
        value={build.rootDirectory}
        onChange={(e) =>
          onBuildChange({ ...build, rootDirectory: e.target.value })
        }
        placeholder="./"
        disabled={disabled}
        className="pl-9 font-mono text-sm"
      />
    </div>
  );

  if (bare) return field;

  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor="root-directory"
        info='Sub-folder to build from, e.g. "apps/web" in a monorepo. Leave as ./ to build from the repository root'
        docs="build.fields"
      >
        Root Directory
      </FieldLabel>
      {field}
    </div>
  );
}
