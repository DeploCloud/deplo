"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { gqlAction } from "@/lib/graphql-client";
import type { SecurityUpdatesStatus } from "@/lib/data/security-updates/settings";
import { timeAgo } from "@/lib/utils";

function statusLine(s: SecurityUpdatesStatus): string {
  if (!s.enabled)
    return "Off: nothing is checked and nothing leaves this Deplo.";
  if (s.failingSince)
    return `Couldn't reach OSV.dev since ${new Date(s.failingSince).toLocaleString()}.`;
  return s.lastCheckedAt
    ? `Checks every app and database. Last checked ${timeAgo(s.lastCheckedAt)}.`
    : "Checks every app and database. Not checked yet.";
}

export function SecurityUpdatesCard({
  status,
}: {
  status: SecurityUpdatesStatus;
}) {
  const router = useRouter();
  const [on, setOn] = React.useState(status.enabled);
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    const previous = on;
    setOn(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($enabled: Boolean!) {
           setSecurityUpdatesEnabled(enabled: $enabled) { enabled }
         }`,
        { enabled: next },
      );
      if (res.ok) {
        router.refresh();
        toast.success(
          next ? "Security updates are on" : "Security updates are off",
        );
      } else {
        setOn(previous);
        toast.error(res.error);
      }
    });
  }

  return (
    <SettingItem
      icon={ShieldAlert}
      title="Security updates"
      htmlFor="security-updates-enabled"
      info="Deplo sends OSV.dev the name and version of each package your apps use, nothing that names your apps or this Deplo."
      description={statusLine({ ...status, enabled: on })}
      control={
        <Switch
          id="security-updates-enabled"
          checked={on}
          disabled={pending}
          onCheckedChange={toggle}
        />
      }
    />
  );
}
