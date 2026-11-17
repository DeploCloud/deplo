"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { ConfirmAction } from "@/components/shared/confirm-action";
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
  const [confirming, setConfirming] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  async function save(next: boolean) {
    const res = await gqlAction(
      `mutation($enabled: Boolean!) {
         setSecurityUpdatesEnabled(enabled: $enabled) { enabled }
       }`,
      { enabled: next },
    );
    if (res.ok) {
      setOn(next);
      router.refresh();
    }
    return res;
  }

  // Off is the risky way: it asks first.
  function toggle(next: boolean) {
    if (!next) return setConfirming(true);
    startTransition(async () => {
      const res = await save(true);
      if (res.ok) toast.success("Security updates are on");
      else toast.error(res.error);
    });
  }

  return (
    <SettingItem
      icon={ShieldAlert}
      title="Security updates"
      htmlFor="security-updates-enabled"
      info="Deplo sends OSV.dev the name and version of each package your apps use, nothing that names your apps or this Deplo."
      docs="security.updatesPrivacy"
      description={statusLine({ ...status, enabled: on })}
      control={
        <Switch
          id="security-updates-enabled"
          checked={on}
          disabled={pending}
          onCheckedChange={toggle}
        />
      }
    >
      <ConfirmAction
        open={confirming}
        onOpenChange={setConfirming}
        title="Turn off security updates?"
        description="Deplo stops checking your apps and databases for known vulnerabilities."
        consequence="A package with a known flaw keeps running, and nobody is told about it. Nothing is sent to OSV.dev."
        confirmLabel="Turn off"
        successMessage="Security updates are off"
        onConfirm={() => save(false)}
      />
    </SettingItem>
  );
}
