"use client";

import { FolderTree } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import type { BuildConfig } from "@/lib/types/build";

export function RootDirectoryFields({
  build,
  onBuildChange,
  disabled,
}: {
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <FieldLabel
          htmlFor="root-directory"
          info='For a monorepo, e.g. "apps/web". Leave ./ to build from the repository root.'
          docs="build.fields"
        >
          Root directory
        </FieldLabel>
        <p className="mt-1 text-xs text-muted-foreground">
          The folder the app is built from.
        </p>
      </div>
      <div className="relative w-full shrink-0 sm:w-56">
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
    </div>
  );
}
