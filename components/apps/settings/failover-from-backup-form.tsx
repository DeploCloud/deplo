"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { LifeBuoy } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import { AUTO_FAILOVER_LABEL } from "@/lib/apps/failover-copy";
import { gqlAction } from "@/lib/graphql-client";

const SET = /* GraphQL */ `
  mutation ($id: String!, $value: Boolean!) {
    setAppFailoverFromBackup(id: $id, value: $value) {
      id
    }
  }
`;

export function FailoverFromBackupForm({
  appId,
  enabled: initial,
}: {
  appId: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(initial);

  function apply(v: boolean) {
    setEnabled(v);
    startTransition(async () => {
      const res = await gqlAction(SET, { id: appId, value: v });
      if (res.ok) {
        toast.success(
          v
            ? "This app will move on its own from its latest backup"
            : "This app will wait for its server",
        );
        router.refresh();
      } else {
        setEnabled(!v);
        toast.error(res.error);
      }
    });
  }

  return (
    <FeatureRow
      id="failover-from-backup"
      icon={LifeBuoy}
      title={AUTO_FAILOVER_LABEL}
      info="Off, it waits for its server and loses nothing. On, it comes back sooner and loses what it wrote after the backup."
      docs="clusters.appData"
      description="Moves this app to another server on its own when its server stops."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={apply}
          disabled={pending}
          aria-label={AUTO_FAILOVER_LABEL}
        />
      }
    />
  );
}
