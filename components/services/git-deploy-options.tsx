"use client";

import * as React from "react";
import { GitBranch, Info, Tag } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { GitTriggerType } from "@/lib/types";

/**
 * The editable git deploy options shared by the service settings page and the
 * new-service wizard (so both surfaces stay identical): the auto-deploy trigger
 * (push vs new tag), the optional watch-path filter, and the submodules toggle.
 * `watchPaths` is held as raw multiline text; {@link watchPathsToArray} turns it
 * into the list the GraphQL `GitRepoInput.watchPaths` expects.
 */
export interface GitDeployOptionsValue {
  triggerType: GitTriggerType;
  /** Raw textarea contents — one glob per line (commas also accepted). */
  watchPaths: string;
  submodules: boolean;
}

/** Split raw watch-path text into a clean glob list (mirrors parseWatchPaths). */
export function watchPathsToArray(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The seed value for a service that has no repo yet (wizard default). */
export const DEFAULT_GIT_DEPLOY_OPTIONS: GitDeployOptionsValue = {
  triggerType: "push",
  watchPaths: "",
  submodules: false,
};

export function GitDeployOptions({
  value,
  onChange,
  disabled,
}: {
  value: GitDeployOptionsValue;
  onChange: (next: GitDeployOptionsValue) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<GitDeployOptionsValue>) =>
    onChange({ ...value, ...patch });

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* Deploy trigger — push to branch vs any new tag. */}
      <div className="space-y-2">
        <Label>Deploy trigger</Label>
        <Select
          value={value.triggerType}
          onValueChange={(v) => set({ triggerType: v as GitTriggerType })}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="push">
              <span className="flex items-center gap-2">
                <GitBranch className="size-4 text-muted-foreground" />
                On push to branch
              </span>
            </SelectItem>
            <SelectItem value="tag">
              <span className="flex items-center gap-2">
                <Tag className="size-4 text-muted-foreground" />
                On new tag
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          When automatic deployments are on, deploy on a push to the branch, or on
          any new tag.
        </p>
      </div>

      {/* Include submodules — clone git submodules at build time. */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5">
          Include submodules
          <SimpleTooltip
            content={
              <span className="block max-w-xs">
                Git submodules embed another repository inside this one, pinned to a
                specific commit. Enabling this clones them too (
                <code className="font-mono">git clone --recurse-submodules</code>),
                so their code is present when your app builds. Leave it off if your
                repository doesn&apos;t use submodules.
              </span>
            }
          >
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label="What are submodules?"
            >
              <Info className="size-3.5" />
            </button>
          </SimpleTooltip>
        </Label>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">
            Clone the repository&apos;s git submodules.
          </p>
          <Switch
            checked={value.submodules}
            onCheckedChange={(v) => set({ submodules: v })}
            disabled={disabled}
          />
        </div>
      </div>

      {/* Watch paths — optional path filter for auto-deploys. */}
      <div className="space-y-2 sm:col-span-2">
        <Label>
          Watch paths{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          value={value.watchPaths}
          onChange={(e) => set({ watchPaths: e.target.value })}
          placeholder={"apps/web/**\npackages/ui/**"}
          rows={3}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          Only auto-deploy when a changed file matches one of these globs (one per
          line). Leave empty to deploy on any change.
        </p>
      </div>
    </div>
  );
}
