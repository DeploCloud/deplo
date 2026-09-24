"use client";

import * as React from "react";
import { toast } from "sonner";
import { FlaskConical } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { gqlAction } from "@/lib/graphql-client";

export function CanaryReleasesCard({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    onChange(next);
    startTransition(async () => {
      const res = await gqlAction(
        /* GraphQL */ `
          mutation SetCanaryReleases($enabled: Boolean!) {
            setCanaryReleases(enabled: $enabled) {
              canary
            }
          }
        `,
        { enabled: next },
      );
      if (res.ok) {
        toast.success(
          next ? "Canary releases turned on" : "Back to stable releases",
        );
      } else {
        onChange(!next);
        toast.error(res.error);
      }
    });
  }

  return (
    <SettingItem
      icon={FlaskConical}
      title="Canary releases"
      htmlFor="canary-releases"
      info="New versions before they are marked stable. They can have bugs, and nothing installs until you click Update."
      docs="upgrade.releases"
      description={
        enabled
          ? "Every new version shows up as an update."
          : "Only stable versions show up as updates."
      }
      control={
        <Switch
          id="canary-releases"
          checked={enabled}
          disabled={pending}
          onCheckedChange={toggle}
        />
      }
    />
  );
}
