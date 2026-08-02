"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Build cache controls for one app: reuse the layers from its last build (on by
 * default — it is what makes a redeploy of an unchanged app take seconds), and a
 * button to start the next build from scratch.
 *
 * Both are ADVANCED: the parent renders this inside the Build & Output card's
 * "Advanced" panel, so a first-run user never meets them, and both are inert
 * until touched. They save on change / on click rather than joining the card's
 * Save button — a switch that needs a separate Save is the classic way to make
 * someone think a setting stuck when it didn't.
 *
 * "Clear" arms a one-shot the next build consumes; nothing is pruned on the
 * server. The BuildKit cache is per-SERVER and shared by every app on it, so
 * deleting it from one app's settings would silently slow down its neighbours —
 * an app can only clear its own by refusing to read it once. Reclaiming disk is
 * the server-wide Docker cleanup's job (Servers → Cleanup).
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
        setEnabled(!value); // the server refused — don't show a state it doesn't have
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
    <div className="space-y-3">
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
                  fresh dependencies every time — it makes every deploy slower.
                </>
              }
            />
          </p>
          <p className="text-xs text-muted-foreground">
            Reuse the layers from this app&apos;s last build. Off rebuilds
            everything, on every deploy.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={saving}
          aria-label="Build cache"
        />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Clear build cache</p>
          <p className="text-xs text-muted-foreground">
            {!enabled
              ? "Not needed while the build cache is off — every build already starts from scratch."
              : pending
                ? "Cleared. The next deployment builds from scratch, then caches again."
                : "The next deployment builds from scratch, then caches again. Only this app is affected."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={clear}
          disabled={saving || !enabled || pending}
        >
          <Eraser className="size-4" />
          {pending ? "Cleared" : "Clear cache"}
        </Button>
      </div>
    </div>
  );
}
