"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";

/**
 * The build cache of one app, as ONE setting: reuse the layers from its last build
 * (on by default - it is what makes a redeploy of an unchanged app take seconds),
 * with the button that starts the next build from scratch sitting beside its own
 */
export function BuildCachePanel({
  appId,
  buildCache,
  clearPending,
  onChange,
}: {
  appId: string;
  buildCache: boolean;
  /** A "Clear build cache" is already armed and waiting for the next build. */
  clearPending: boolean;
  /** Report a committed change so the parent's collapsed summary stays honest. */
  onChange?: (next: { buildCache: boolean; clearPending: boolean }) => void;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(buildCache);
  const [pending, setPending] = React.useState(clearPending);
  const [saving, startTransition] = React.useTransition();

  function toggle(value: boolean) {
    setEnabled(value);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $value: Boolean!) { updateAppBuild(id: $id, build: { buildCache: $value }) { id } }`,
        { id: appId, value },
      );
      if (res.ok) {
        onChange?.({ buildCache: value, clearPending: pending });
        toast.success(value ? "Build cache enabled" : "Build cache disabled");
        router.refresh();
      } else {
        setEnabled(!value); // the server refused - don't show a state it doesn't have
        toast.error(res.error);
      }
    });
  }

  function clear() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!) { clearAppBuildCache(id: $id) { id } }`,
        { id: appId },
      );
      if (res.ok) {
        setPending(true);
        onChange?.({ buildCache: enabled, clearPending: true });
        toast.success("Build cache cleared");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
      <div className="space-y-0.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          Build cache
          <InfoTip
            content={
              <>
                Deplo reuses the Docker layers your last build produced on this
                app&apos;s server, so a deploy that changes nothing takes
                seconds instead of minutes. Turn it off when a build must pull
                fresh dependencies every time - it makes every deploy slower.
              </>
            }
            docs="build.cache"
          />
        </p>
        <p className="text-xs text-muted-foreground">
          {pending
            ? "Cleared - the next deployment builds from scratch, then caches again."
            : "Reuse the layers from this app's last build. Off rebuilds everything, on every deploy."}
        </p>
      </div>
      {/**
       * Clearing sits WITH the setting it acts on, ahead of the switch: it is the same
       * subject, and a whole panel for one button read as a second feature.
       */}
      <div className="flex shrink-0 items-center gap-3">
        <SimpleTooltip
          content={
            !enabled
              ? "Not needed while the build cache is off - every build already starts from scratch."
              : pending
                ? "Already armed. The next deployment builds from scratch."
                : "The next deployment builds from scratch, then caches again. Only this app is affected - the server's cache is shared, so nothing is deleted from it."
          }
        >
          {/* A disabled button fires no pointer events, so the tooltip needs a
              wrapper to hang off, otherwise the explanation is unreachable in
              exactly the state that needs it. */}
          <span className="inline-flex">
            <Button
              size="sm"
              variant="outline"
              onClick={clear}
              disabled={saving || !enabled || pending}
            >
              <Eraser className="size-4" />
              {pending ? "Cleared" : "Clear cache"}
            </Button>
          </span>
        </SimpleTooltip>
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={saving}
          aria-label="Build cache"
        />
      </div>
    </div>
  );
}
