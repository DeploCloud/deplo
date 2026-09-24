"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { UserRound } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { gqlAction } from "@/lib/graphql-client";

export function GravatarCard({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = React.useState(enabled);
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    const previous = on;
    setOn(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($enabled: Boolean!) {
           setGravatarEnabled(enabled: $enabled) { gravatarEnabled }
         }`,
        { enabled: next },
      );
      if (res.ok) {
        router.refresh();
        toast.success(
          next ? "Gravatar pictures are on" : "Gravatar pictures are off",
        );
      } else {
        setOn(previous);
        toast.error(res.error);
      }
    });
  }

  return (
    <SettingItem
      icon={UserRound}
      title="Gravatar pictures"
      htmlFor="gravatar-enabled"
      info="On, each browser fetches the picture from gravatar.com using a hash of the address. Off, nothing leaves this instance."
      description="For people who have not uploaded a picture of their own."
      control={
        <Switch
          id="gravatar-enabled"
          checked={on}
          disabled={pending}
          onCheckedChange={toggle}
        />
      }
    />
  );
}
