"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Eraser, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";

export function BuildCachePanel({
  appId,
  buildCache,
  clearPending,
  onChange,
}: {
  appId: string;
  buildCache: boolean;
  clearPending: boolean;
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
        setEnabled(!value);
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
    <FeatureRow
      icon={Layers}
      title="Build cache"
      info="Reuses what the last build produced, so a deploy that changes nothing takes seconds. Off, every deploy pulls fresh dependencies and is slower."
      docs="build.cache"
      description={
        pending
          ? "Cleared - the next deployment builds from scratch, then caches again."
          : "Reuse the layers from this app's last build. Off rebuilds everything, on every deploy."
      }
      control={
        <>
          <SimpleTooltip
            content={
              !enabled
                ? "Not needed while the build cache is off - every build already starts from scratch."
                : pending
                  ? "Already armed. The next deployment builds from scratch."
                  : "The next deployment builds from scratch, then caches again. Only this app is affected - the server's cache is shared, so nothing is deleted from it."
            }
          >
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
        </>
      }
    />
  );
}
