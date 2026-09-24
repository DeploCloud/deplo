"use client";

import * as React from "react";
import { toast } from "sonner";
import { FlaskConical } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { ConfirmAction } from "@/components/shared/confirm-action";
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
  const [confirming, setConfirming] = React.useState(false);

  async function save(next: boolean) {
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
    if (res.ok) onChange(next);
    return res;
  }

  function toggle(next: boolean) {
    if (next) return setConfirming(true);
    startTransition(async () => {
      const res = await save(false);
      if (res.ok) toast.success("Back to stable releases");
      else toast.error(res.error);
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
    >
      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title="Turn on canary releases?"
        description={
          <>
            From now on,{" "}
            <strong>every new version shows up as an update</strong>, before it
            is marked stable.
          </>
        }
        consequence="Canary versions can be unstable and break the panel. Not recommended for production."
        confirmLabel="Turn on canary releases"
        successMessage="Canary releases turned on"
        onConfirm={() => save(true)}
      />
    </SettingItem>
  );
}
