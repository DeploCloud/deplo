"use client";

import { FolderTree } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import type { BuildConfig } from "@/lib/types";

/**
 * The "Root Directory" section: which sub-path of the repo the build runs from.
 * Owns no persistence — the parent holds the {@link BuildConfig} and saves it via
 * `updateServiceBuild` (root directory is stored on `service_build`, same as the
 * other build fields). Mirrors {@link BuildConfigFields}' props shape.
 *
 * Only surfaced for source-bearing repo builds (git / GitHub); a compose stack or
 * a prebuilt Docker image has no single tree to root into, so the parent gates it.
 */
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
    <div className="space-y-2">
      <FieldLabel
        htmlFor="root-directory"
        info={
          <>
            The directory Deplo builds from, relative to the repository root.
            Leave as <code className="font-mono">./</code> to build from the
            repository root; set it to a sub-folder (e.g.{" "}
            <code className="font-mono">apps/web</code>) for a monorepo.
          </>
        }
      >
        Root Directory
      </FieldLabel>
      <div className="relative max-w-md">
        <FolderTree className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="root-directory"
          value={build.rootDirectory}
          onChange={(e) => onBuildChange({ ...build, rootDirectory: e.target.value })}
          placeholder="./"
          disabled={disabled}
          className="pl-9 font-mono text-sm"
        />
      </div>
    </div>
  );
}
